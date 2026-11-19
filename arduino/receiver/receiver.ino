/*
 * Smart Factory — LoRa USB-Serial Receiver (Coordinator)
 * Receives LoRa packets from NODE_01, NODE_02, NODE_03
 * Sends ACK back to sender
 * Forwards JSON over USB Serial with "GW_JSON:" prefix
 * → serial_bridge_ingest.py reads this and POSTs to Flask
 *
 * PIN CONNECTIONS (ESP32):
 *   SX1278  CS   → GPIO 5
 *           DIO0 → GPIO 2
 *           RST  → GPIO 4
 *           SCK  → GPIO 18
 *           MISO → GPIO 19
 *           MOSI → GPIO 23
 *
 * IMPORTANT:
 *   - Use SX1278 (NOT SX1276) for 433 MHz with senders
 *   - Same LoRa settings as all sender nodes (BW, SF, CR, sync)
 *   - Set USB serial baud to 115200 in serial_bridge_ingest.py
 */

#include <ArduinoJson.h>
#include <RadioLib.h>
#include <SPI.h>
#include <Wire.h>

// ============================================================
// LoRa Config — MUST match all sender nodes exactly
// ============================================================
#define LORA_CS       5
#define LORA_DIO0     2
#define LORA_RST      4
#define LORA_SCK      18
#define LORA_MISO     19
#define LORA_MOSI     23

#define LORA_FREQ     433.0
#define LORA_BW_KHZ   125.0f
#define LORA_SF       11
#define LORA_CR       8
#define LORA_SYNC     0x12
#define LORA_POWER    17
#define LORA_PREAMBLE 8

#define GATEWAY_ID    "GATEWAY_01"

// ============================================================
// Node tracking (online/offline)
// ============================================================
#define MAX_TRACKED_NODES 6
#define NODE_OFFLINE_MS   30000UL   // 30 sec without packet = offline

struct NodeRecord {
  char nodeId[16];
  unsigned long lastSeenMs;
  unsigned long packetsRx;
  unsigned long ackedTx;
  bool online;
};

NodeRecord trackedNodes[MAX_TRACKED_NODES];
int trackedCount = 0;

// ============================================================
// Duplicate detection (suppress same seq from same node)
// ============================================================
#define MAX_RECENT 20
struct RecentMsg {
  char nodeId[16];
  unsigned long seq;
  unsigned long seenAt;
};
RecentMsg recentMsgs[MAX_RECENT];
int recentHead = 0;

bool isDuplicate(const char* nodeId, unsigned long seq) {
  for (int i = 0; i < MAX_RECENT; i++) {
    if (recentMsgs[i].seenAt == 0) continue;
    if (strcmp(recentMsgs[i].nodeId, nodeId) == 0 && recentMsgs[i].seq == seq) {
      if (millis() - recentMsgs[i].seenAt < 10000UL) return true;
    }
  }
  // Store
  strncpy(recentMsgs[recentHead].nodeId, nodeId, 15);
  recentMsgs[recentHead].seq    = seq;
  recentMsgs[recentHead].seenAt = millis();
  recentHead = (recentHead + 1) % MAX_RECENT;
  return false;
}

// ============================================================
// LoRa Radio
// ============================================================
SX1278 radio = new Module(LORA_CS, LORA_DIO0, LORA_RST);
volatile bool packetReady = false;

void IRAM_ATTR onReceive() {
  packetReady = true;
}

// ============================================================
// Distance estimate from RSSI/SNR
// ============================================================
float estimateDistance(float rssi, float snr) {
  const float rssiAt1m = -54.0f;
  const float pathExp  = 2.1f;
  float snrPenalty = constrain(-snr * 0.9f, 0.0f, 10.0f);
  float adjRssi = rssi - snrPenalty;
  float exp_val = (rssiAt1m - adjRssi) / (10.0f * pathExp);
  float dist = powf(10.0f, exp_val);
  return constrain(dist, 0.5f, 800.0f);
}

// ============================================================
// Node record helpers
// ============================================================
int findOrAddNode(const char* nodeId) {
  for (int i = 0; i < trackedCount; i++) {
    if (strcmp(trackedNodes[i].nodeId, nodeId) == 0) return i;
  }
  if (trackedCount < MAX_TRACKED_NODES) {
    strncpy(trackedNodes[trackedCount].nodeId, nodeId, 15);
    trackedNodes[trackedCount].lastSeenMs = 0;
    trackedNodes[trackedCount].packetsRx  = 0;
    trackedNodes[trackedCount].ackedTx    = 0;
    trackedNodes[trackedCount].online     = false;
    return trackedCount++;
  }
  // Replace oldest
  int oldest = 0;
  for (int i = 1; i < MAX_TRACKED_NODES; i++) {
    if (trackedNodes[i].lastSeenMs < trackedNodes[oldest].lastSeenMs) oldest = i;
  }
  strncpy(trackedNodes[oldest].nodeId, nodeId, 15);
  trackedNodes[oldest].packetsRx = 0;
  return oldest;
}

void updateNodeStatus() {
  unsigned long now = millis();
  for (int i = 0; i < trackedCount; i++) {
    trackedNodes[i].online = (now - trackedNodes[i].lastSeenMs) < NODE_OFFLINE_MS;
  }
}

// ============================================================
// Send ACK to node
// ============================================================
bool sendAck(const char* nodeId, unsigned long seq) {
  char ackBuf[48];
  snprintf(ackBuf, sizeof(ackBuf), "ACK:%s:%lu", nodeId, seq);
  int state = radio.transmit(ackBuf);
  // Re-arm receiver immediately after TX
  radio.startReceive();
  return state == RADIOLIB_ERR_NONE;
}

// ============================================================
// Extract JSON from raw payload (strip noise bytes)
// ============================================================
String extractJson(const String& raw) {
  int start = raw.indexOf('{');
  int end   = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.substring(start, end + 1);
  return raw;
}

// ============================================================
// Handle incoming LoRa packet
// ============================================================
void handlePacket() {
  String raw;
  int state = radio.readData(raw);
  radio.startReceive();   // Re-arm immediately

  if (state != RADIOLIB_ERR_NONE || raw.length() == 0) return;

  // Ignore ACK echoes
  if (raw.startsWith("ACK:")) return;

  String payload = extractJson(raw);
  if (!payload.startsWith("{")) {
    Serial.print("[RX] Non-JSON: ");
    Serial.println(payload);
    return;
  }

  // Read RSSI & SNR before we do anything else
  float rssi = radio.getRSSI();
  float snr  = radio.getSNR();
  float distEst = estimateDistance(rssi, snr);

  Serial.println("\n--- LoRa Packet Received ---");
  Serial.println(payload);
  Serial.printf("RSSI=%.1f SNR=%.1f DistEst=%.1fm\n", rssi, snr, distEst);

  // Parse JSON
  StaticJsonDocument<768> rx;
  DeserializationError err = deserializeJson(rx, payload);
  if (err) {
    Serial.print("[RX] JSON parse fail: ");
    Serial.println(err.c_str());
    return;
  }

  const char* nodeId = rx["node_id"] | "UNKNOWN";
  unsigned long seq  = rx["seq"] | 0;
  bool retransmit    = rx["retransmit"] | false;
  int retryCount     = rx["retry_count"] | (retransmit ? 1 : 0);

  // Duplicate check
  if (isDuplicate(nodeId, seq)) {
    Serial.printf("[RX] Duplicate seq=%lu from %s — dropped\n", seq, nodeId);
    sendAck(nodeId, seq);  // Still ACK so sender knows it was received
    return;
  }

  // Update node record
  int idx = findOrAddNode(nodeId);
  trackedNodes[idx].lastSeenMs = millis();
  trackedNodes[idx].packetsRx++;
  trackedNodes[idx].online = true;

  // Send ACK
  bool ackOk = sendAck(nodeId, seq);
  Serial.printf("[RX] ACK %s seq=%lu: %s\n", nodeId, seq, ackOk ? "SENT" : "FAIL");
  if (ackOk) trackedNodes[idx].ackedTx++;

  // Build enriched output JSON
  StaticJsonDocument<896> out;
  out["gateway_id"]  = GATEWAY_ID;
  out["node_id"]     = nodeId;
  out["seq"]         = seq;
  out["timestamp"]   = rx["timestamp"] | (unsigned long)millis();
  out["smoke"]       = rx["smoke"]    | (rx["smoke_ppm"]  | 0);
  out["gas"]         = rx["gas"]      | (rx["gas_ppm"]    | 0);
  out["flame"]       = rx["flame"]    | 0;
  out["distance"]    = rx["distance"] | (rx["object_distance_cm"] | 0);
  out["vib"]         = rx["vib"]      | (rx["vib_magnitude"] | 0.0f);
  out["ax"]          = rx["ax"]       | 0.0f;
  out["ay"]          = rx["ay"]       | 0.0f;
  out["az"]          = rx["az"]       | 0.0f;
  out["lat"]         = rx["lat"]      | 0.0f;
  out["lon"]         = rx["lon"]      | 0.0f;
  out["anomaly"]     = rx["anomaly"]  | false;

  // Gateway metadata
  out["gateway_rssi"]               = roundf(rssi * 10) / 10.0f;
  out["gateway_snr"]                = roundf(snr  * 10) / 10.0f;
  out["gateway_distance_estimate_m"]= roundf(distEst * 10) / 10.0f;
  out["node_gateway_distance_m"]    = roundf(distEst * 10) / 10.0f;
  out["gateway_ack_sent"]           = ackOk;
  out["retransmit"]                 = retransmit;
  out["retry_count"]                = retryCount;
  out["delivery_status"]            = ackOk ? "ACKED" : "RECEIVED";
  out["message_duplicate"]          = false;

  // Cumulative stats from sender (if available)
  out["acked_packets_total"]  = rx["acked_total"]   | (unsigned long)0;
  out["dropped_packets_total"]= rx["dropped_total"] | (unsigned long)0;
  out["ack_timeouts_total"]   = rx["ack_timeouts"]  | (unsigned long)0;
  out["tx_attempts_total"]    = rx["tx_attempts"]   | (unsigned long)0;

  // Forward to Python bridge via USB Serial
  String outStr;
  serializeJson(out, outStr);
  Serial.print("GW_JSON:");
  Serial.println(outStr);
}

// ============================================================
// Status print every 15s
// ============================================================
unsigned long lastStatusAt = 0;

void printStatus() {
  if (millis() - lastStatusAt < 15000UL) return;
  lastStatusAt = millis();
  Serial.println("\n=== RECEIVER STATUS ===");
  updateNodeStatus();
  for (int i = 0; i < trackedCount; i++) {
    Serial.printf("  %s: %s | RX=%lu ACK=%lu\n",
      trackedNodes[i].nodeId,
      trackedNodes[i].online ? "ONLINE" : "OFFLINE",
      trackedNodes[i].packetsRx,
      trackedNodes[i].ackedTx);
  }
  Serial.println("=======================");
}

// ============================================================
// SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println("\n=== SMART FACTORY RECEIVER STARTED ===");
  Serial.printf("Gateway ID: %s\n", GATEWAY_ID);
  Serial.println("Listening for LoRa packets from NODE_01, NODE_02, NODE_03...");

  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_CS);

  int state = radio.begin(LORA_FREQ, LORA_BW_KHZ, LORA_SF, LORA_CR,
                          LORA_SYNC, LORA_POWER, LORA_PREAMBLE);
  if (state != RADIOLIB_ERR_NONE) {
    Serial.printf("[RECEIVER] LoRa init FAIL code=%d — halting\n", state);
    while (true) { delay(1000); }
  }

  radio.setDio0Action(onReceive, RISING);
  radio.startReceive();
  Serial.println("[RECEIVER] LoRa SX1278 @ 433 MHz — Ready");
  Serial.println("[RECEIVER] Forwarding to PC via USB Serial (GW_JSON: prefix)");
}

// ============================================================
// LOOP
// ============================================================
void loop() {
  if (packetReady) {
    packetReady = false;
    handlePacket();
  }
  printStatus();
  delay(10);
}
