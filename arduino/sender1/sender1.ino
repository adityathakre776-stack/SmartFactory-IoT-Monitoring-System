/*
 * Smart Factory — LoRa Sender NODE_03
 * Sensors: MQ2 Smoke | MQ135 Gas | Flame | MPU6050 | HC-SR04 | GPS (optional)
 * LoRa: SX1278 @ 433 MHz
 *
 * PIN CONNECTIONS (ESP32):
 *   MQ2  AOUT → GPIO 32
 *   MQ135 AOUT → GPIO 33
 *   Flame  DO  → GPIO 26  (LOW = flame detected)
 *   HC-SR04 TRIG → GPIO 27 | ECHO → GPIO 25
 *   MPU6050 SDA → GPIO 21 | SCL → GPIO 22  (I2C)
 *   SX1278  CS → GPIO 5 | DIO0 → GPIO 2 | RST → GPIO 4
 *   GPS     RX2 → GPIO 16 | TX2 → GPIO 17  (if HAS_GPS = 1)
 */

#include <ArduinoJson.h>
#include <Wire.h>
#include <RadioLib.h>
#include <SPI.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

#define HAS_GPS 0
#if HAS_GPS
  #include <TinyGPSPlus.h>
  TinyGPSPlus gps;
  HardwareSerial GPSSerial(2);
#endif

// ================= CONFIG =================
#define NODE_ID       "NODE_03"
#define GATEWAY_ID    "GATEWAY_01"

#define SMOKE_PIN     32
#define GAS_PIN       33
#define FLAME_PIN     26
#define TRIG_PIN      27
#define ECHO_PIN      25

#define LORA_CS       5
#define LORA_DIO0     2
#define LORA_RST      4
#define LORA_FREQ     433.0
#define LORA_BW_KHZ   125.0f
#define LORA_SF       11
#define LORA_CR       8
#define LORA_SYNC     0x12
#define LORA_POWER    17
#define LORA_PREAMBLE 8

#define ADC_MAX       4095.0
#define RL_VALUE      10.0

#define ACK_TIMEOUT_MS     800
#define MAX_RETRIES        3
#define TX_INTERVAL_MS     2000

// ================= GLOBALS =================
SX1278 radio = new Module(LORA_CS, LORA_DIO0, LORA_RST);
Adafruit_MPU6050 mpu;

// Hardcoded R0 baseline (clean-air resistance ratio, datasheet typical).
// To calibrate: run with calibrateMQ() after a 60s warm-up, note the printed
// R0 values, then paste them here and re-flash.
float R0_smoke = 10.0;   // update after a proper warm-up calibration run
float R0_gas   = 10.0;   // update after a proper warm-up calibration run
bool  loraOk   = false;
bool  mpuOk    = false;

unsigned long seq            = 0;
unsigned long lastTxAt       = 0;
bool hasPendingPayload       = false;
String pendingPayload        = "";
unsigned long pendingSeq     = 0;
int pendingRetries           = 0;

unsigned long ackedTotal     = 0;
unsigned long droppedTotal   = 0;
unsigned long ackTimeouts    = 0;
unsigned long txAttempts     = 0;

float lastValidDistanceCm    = 0.0;

// ================= MQ HELPERS =================
float calculateResistance(int adcValue) {
  float voltage = (adcValue / ADC_MAX) * 3.3f;
  if (voltage <= 0.01f) return 999.0f;
  return (3.3f - voltage) * RL_VALUE / voltage;
}

// calibrateMQ() — call this once after a 60s warm-up to measure your R0.
// Note the printed values and hardcode them above, then remove this call.
void calibrateMQ() {
  Serial.println("[NODE_03] Calibrating MQ sensors (clean air)...");
  float smokeSum = 0, gasSum = 0;
  for (int i = 0; i < 50; i++) {
    smokeSum += calculateResistance(analogRead(SMOKE_PIN));
    gasSum   += calculateResistance(analogRead(GAS_PIN));
    delay(200);
  }
  R0_smoke = (smokeSum / 50.0f) / 9.83f;
  R0_gas   = (gasSum   / 50.0f) / 9.83f;
  if (R0_smoke < 0.01f) R0_smoke = 1.0f;
  if (R0_gas   < 0.01f) R0_gas   = 1.0f;
  Serial.printf("[NODE_03] R0_smoke=%.2f R0_gas=%.2f\n", R0_smoke, R0_gas);
}

float readSmokePpm(int adcVal) {
  if (adcVal <= 0 || adcVal > 4000) return 0;
  float ratio = calculateResistance(adcVal) / R0_smoke;
  if (ratio <= 0) return 0;
  float ppm = powf(10.0f, ((log10f(ratio) - 0.3f) / -0.45f));
  return (ppm > 10000 || isnan(ppm)) ? 0 : ppm;
}

float readGasPpm(int adcVal) {
  if (adcVal <= 0 || adcVal > 4000) return 0;
  float ratio = calculateResistance(adcVal) / R0_gas;
  if (ratio <= 0) return 0;
  float ppm = powf(10.0f, ((log10f(ratio) - 0.2f) / -0.38f));
  return (ppm > 10000 || isnan(ppm)) ? 0 : ppm;
}

// ================= HC-SR04 =================
float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long dur = pulseIn(ECHO_PIN, HIGH, 30000UL);
  if (dur == 0) return -1.0f;
  float d = dur * 0.01715f;
  return (d < 2.0f || d > 500.0f) ? -1.0f : d;
}

float readStableDistance() {
  float sum = 0; int cnt = 0;
  for (int i = 0; i < 5; i++) {
    float d = readDistanceCm();
    if (d > 0) { sum += d; cnt++; }
    delay(20);
  }
  if (cnt > 0) lastValidDistanceCm = sum / cnt;
  return lastValidDistanceCm;
}

// ================= MPU6050 =================
float readVibMagnitude(float &ax_out, float &ay_out, float &az_out) {
  if (!mpuOk) { ax_out = ay_out = az_out = 0; return 0; }
  sensors_event_t a, g, t;
  if (!mpu.getEvent(&a, &g, &t)) { ax_out = ay_out = az_out = 0; return 0; }
  ax_out = a.acceleration.x;
  ay_out = a.acceleration.y;
  az_out = a.acceleration.z;
  return sqrtf(ax_out*ax_out + ay_out*ay_out + az_out*az_out);
}

// ================= LORA ACK/TX =================
bool sendWithAck(const String& payload, int &retryCount) {
  retryCount = 0;
  for (int attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    txAttempts++;
    String txPayload = payload;  // transmit() requires non-const String&
    int txState = radio.transmit(txPayload);
    if (txState != RADIOLIB_ERR_NONE) {
      Serial.printf("[NODE_03] TX fail code=%d\n", txState);
      delay(200);
      continue;
    }
    String ack;
    int rxState = radio.receive(ack, ACK_TIMEOUT_MS);
    if (rxState == RADIOLIB_ERR_NONE && ack.startsWith("ACK:")) {
      int noise = -1;
      for (int i = 0; i < (int)ack.length(); i++) {
        char c = ack[i];
        if (!(c >= 32 && c <= 126)) { noise = i; break; }
      }
      if (noise > 0) ack = ack.substring(0, noise);
      Serial.printf("[NODE_03] ACK OK (attempt %d): %s\n", attempt+1, ack.c_str());
      ackedTotal++;
      return true;
    }
    ackTimeouts++;
    retryCount = attempt + 1;
    Serial.printf("[NODE_03] ACK timeout attempt %d/%d\n", attempt+1, MAX_RETRIES+1);
    delay(300 + attempt * 200);
  }
  droppedTotal++;
  return false;
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== NODE_03 STARTING ===");

  Wire.begin();

  pinMode(SMOKE_PIN, INPUT);
  pinMode(GAS_PIN,   INPUT);
  pinMode(FLAME_PIN, INPUT);
  pinMode(TRIG_PIN,  OUTPUT);
  pinMode(ECHO_PIN,  INPUT);
  digitalWrite(TRIG_PIN, LOW);

  if (mpu.begin()) {
    mpuOk = true;
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    Serial.println("[NODE_03] MPU6050 OK");
  } else {
    Serial.println("[NODE_03] MPU6050 not found — vib=0");
  }

#if HAS_GPS
  GPSSerial.begin(9600, SERIAL_8N1, 16, 17);
  Serial.println("[NODE_03] GPS serial started");
#endif

  SPI.begin();
  int state = radio.begin(LORA_FREQ, LORA_BW_KHZ, LORA_SF, LORA_CR,
                          LORA_SYNC, LORA_POWER, LORA_PREAMBLE);
  if (state == RADIOLIB_ERR_NONE) {
    loraOk = true;
    Serial.println("[NODE_03] LoRa SX1278 OK @ 433 MHz");
  } else {
    Serial.printf("[NODE_03] LoRa FAIL code=%d\n", state);
  }

  for (int i = 0; i < 3; i++) { readStableDistance(); delay(50); }

  // R0 is hardcoded — no warm-up or runtime calibration needed.
  // See R0_smoke / R0_gas at the top to update values after a calibration run.
  Serial.printf("[NODE_03] Using hardcoded R0: smoke=%.2f gas=%.2f\n", R0_smoke, R0_gas);
  Serial.println("[NODE_03] Ready — transmitting every 2s");
}

// ================= LOOP =================
void loop() {
#if HAS_GPS
  while (GPSSerial.available()) gps.encode(GPSSerial.read());
#endif

  if (hasPendingPayload && loraOk) {
    Serial.printf("[NODE_03] Retrying pending seq=%lu\n", pendingSeq);
    int rc = 0;
    if (sendWithAck(pendingPayload, rc)) {
      Serial.println("[NODE_03] Pending packet ACKed");
      hasPendingPayload = false;
      pendingPayload = "";
      pendingRetries = 0;
      pendingSeq = 0;
    } else {
      pendingRetries++;
      if (pendingRetries >= 5) {
        Serial.println("[NODE_03] Dropping stale packet");
        hasPendingPayload = false;
        pendingRetries = 0;
      }
    }
    return;
  }

  if (millis() - lastTxAt < TX_INTERVAL_MS) { delay(50); return; }
  lastTxAt = millis();
  seq++;

  int smokeRaw = analogRead(SMOKE_PIN);
  int gasRaw   = analogRead(GAS_PIN);
  int flame    = (digitalRead(FLAME_PIN) == LOW) ? 1 : 0;
  float distCm = readStableDistance();
  float ax = 0, ay = 0, az = 0;
  float vib = readVibMagnitude(ax, ay, az);
  vib = roundf(vib * 100) / 100.0f;

  float smokePpm = readSmokePpm(smokeRaw);
  float gasPpm   = readGasPpm(gasRaw);
  bool anomaly   = (vib > 9.5f) || (flame == 1) || (gasPpm > 400) || (smokePpm > 1200);

#if HAS_GPS
  float lat = gps.location.isValid() ? gps.location.lat() : 0.0f;
  float lon = gps.location.isValid() ? gps.location.lng() : 0.0f;
#else
  float lat = 0.0f, lon = 0.0f;
#endif

  // --- LoRa air payload (must stay ≤255 bytes) ---
  // Diagnostic counters are logged to Serial only; they grow unboundedly
  // and would push the JSON over the 255-byte SX1278 hard limit.
  StaticJsonDocument<256> doc;
  doc["node_id"]       = NODE_ID;
  doc["gateway_id"]    = GATEWAY_ID;
  doc["seq"]           = seq;
  doc["ts"]            = millis();   // shortened key saves 5 bytes
  doc["smoke"]         = (int)smokePpm;
  doc["gas"]           = (int)gasPpm;
  doc["flame"]         = flame;
  doc["dist"]          = distCm <= 0 ? 0 : (int)distCm;
  doc["vib"]           = vib;
  doc["ax"]            = roundf(ax * 100) / 100.0f;
  doc["ay"]            = roundf(ay * 100) / 100.0f;
  doc["az"]            = roundf(az * 100) / 100.0f;
  doc["lat"]           = lat;
  doc["lon"]           = lon;
  doc["anomaly"]       = anomaly ? 1 : 0;
  doc["retx"]          = false;
  doc["retx_seq"]      = 0;

  String payload;
  serializeJson(doc, payload);

  // Serial debug — stats printed after TX so counts include this attempt
  Serial.printf("[NODE_03] TX (%u B): ", payload.length());
  Serial.println(payload);

  // Guard: catch any future growth before it silently fails
  if (payload.length() > 250) {
    Serial.println("[NODE_03] ERROR: payload too large, skipping TX");
    return;
  }

  if (loraOk) {
    int retryCount = 0;
    bool delivered = sendWithAck(payload, retryCount);
    if (!delivered) {
      doc["retx"]     = true;
      doc["retx_seq"] = seq;
      String retryPayload;
      serializeJson(doc, retryPayload);
      hasPendingPayload = true;
      pendingPayload    = retryPayload;
      pendingSeq        = seq;
      pendingRetries    = 0;
      Serial.printf("[NODE_03] TX failed — queued for retry seq=%lu\n", seq);
    } else {
      Serial.printf("[NODE_03] Delivered seq=%lu\n", seq);
    }
  Serial.printf("[NODE_03] Stats: acked=%lu dropped=%lu timeouts=%lu attempts=%lu\n",
                ackedTotal, droppedTotal, ackTimeouts, txAttempts);
  }
}
