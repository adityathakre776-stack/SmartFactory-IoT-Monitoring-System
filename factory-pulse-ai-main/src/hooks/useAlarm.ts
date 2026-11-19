import { useCallback } from "react";
import { toast } from "@/hooks/use-toast";

let lastAlert = "";
let lastAlertTime = 0;
const ALERT_COOLDOWN = 5000; // speech: same message within 5s

// Toast/beep: one burst per condition type so 3–4s polling does not spam the UI
const TOAST_COOLDOWN_MS = 45000;
let lastToastAtByKind: Record<string, number> = {};

// Thresholds (aligned with KPICards + backend /api/alerts)
const GAS_THRESHOLD      = 400;
const SMOKE_THRESHOLD    = 1200;
const DISTANCE_THRESHOLD = 50;
const FLAME_ALERT        = 1;   // digital 0/1 from nodes
const VIB_THRESHOLD      = 9.5; // g — MPU6050 magnitude

function allowToast(kind: string): boolean {
  const now = Date.now();
  const last = lastToastAtByKind[kind] ?? 0;
  if (now - last < TOAST_COOLDOWN_MS) return false;
  lastToastAtByKind[kind] = now;
  return true;
}

export const useAlarm = () => {
  const playBeep = useCallback(() => {
    try {
      // Create a simple beep sound using Web Audio API
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.frequency.value = 800;
      oscillator.type = "sine";
      
      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
      
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.5);
    } catch (err) {
      console.error("Audio error:", err);
    }
  }, []);

  const speak = useCallback((msg: string) => {
    const now = Date.now();
    if (msg === lastAlert && now - lastAlertTime < ALERT_COOLDOWN) {
      return; // Skip if same alert within cooldown
    }
    
    lastAlert = msg;
    lastAlertTime = now;

    try {
      const speech = new SpeechSynthesisUtterance(msg);
      speech.lang = "en-IN";
      speech.rate = 1.0;
      speech.volume = 1.0;
      window.speechSynthesis.speak(speech);
    } catch (err) {
      console.error("Speech error:", err);
    }
  }, []);

  const triggerAlarm = useCallback(
    (data: any) => {
    const distance = Number(data.distance || 0);
    const flame    = Number(data.flame || 0);
    const gas      = Number(data.gas || data.gas_raw || 0);
    const smoke    = Number(data.smoke || data.smoke_raw || 0);
    const vib      = Number(data.vib || data.vib_magnitude || 0);
    const rawNode  = String(data.node_id || data.nodeId || "Unknown Node");
    // "NODE_01" → "Node 1"
    const nodeLabel = rawNode.replace(/NODE_0?(\d+)/i, "Node $1");

    // Priority order: Flame > Gas > Smoke > Distance
    if (flame >= FLAME_ALERT) {
      if (!allowToast(`flame_${rawNode}`)) return;
      playBeep();
      speak(`Alert! Fire detected at ${nodeLabel}. Please evacuate immediately.`);
      toast({
        variant: "destructive",
        title: `🔥 Fire Detected — ${nodeLabel}`,
        description: `Flame sensor triggered on ${nodeLabel}. Please evacuate immediately.`,
        duration: 10000,
      });
      return;
    }

    if (gas > GAS_THRESHOLD) {
      if (!allowToast(`gas_${rawNode}`)) return;
      playBeep();
      speak(`Alert! Gas leakage detected at ${nodeLabel}. Gas level ${gas.toFixed(0)}. Please check the area.`);
      toast({
        variant: "destructive",
        title: `⚠️ High Gas Level — ${nodeLabel}`,
        description: `Gas level is ${gas.toFixed(0)} on ${nodeLabel} (threshold: ${GAS_THRESHOLD}). Please investigate immediately.`,
        duration: 8000,
      });
      return;
    }

    if (smoke > SMOKE_THRESHOLD) {
      if (!allowToast(`smoke_${rawNode}`)) return;
      playBeep();
      speak(`Alert! Smoke level critical at ${nodeLabel}. Smoke level ${smoke.toFixed(0)}. Please investigate.`);
      toast({
        variant: "destructive",
        title: `💨 High Smoke Level — ${nodeLabel}`,
        description: `Smoke level is ${smoke.toFixed(0)} on ${nodeLabel} (threshold: ${SMOKE_THRESHOLD}). Please investigate immediately.`,
        duration: 8000,
      });
      return;
    }

    if (distance < DISTANCE_THRESHOLD && distance > 0) {
      if (!allowToast(`proximity_${rawNode}`)) return;
      playBeep();
      speak(`Alert! Object detected close to machine at ${nodeLabel}. Distance is ${distance.toFixed(1)} centimeters.`);
      toast({
        variant: "destructive",
        title: `⚠️ Object Too Close — ${nodeLabel}`,
        description: `Object detected at ${distance.toFixed(1)}cm on ${nodeLabel} (threshold: ${DISTANCE_THRESHOLD}cm). Please check the area.`,
        duration: 6000,
      });
      return;
    }

    if (vib > VIB_THRESHOLD) {
      if (!allowToast(`vib_${rawNode}`)) return;
      playBeep();
      speak(`Alert! Abnormal vibration detected at ${nodeLabel}. Magnitude ${vib.toFixed(1)} G.`);
      toast({
        variant: "destructive",
        title: `📳 Abnormal Vibration — ${nodeLabel}`,
        description: `Vibration magnitude is ${vib.toFixed(2)}g on ${nodeLabel} (threshold: ${VIB_THRESHOLD}g). Check machinery.`,
        duration: 6000,
      });
      return;
    }
    },
    [playBeep, speak]
  );

  const triggerNodeOffline = useCallback(
    (nodeId: string) => {
      const nodeLabel = nodeId.replace(/NODE_0?(\d+)/i, "Node $1");
      if (!allowToast(`offline_${nodeId}`)) return;
      playBeep();
      speak(`Warning! ${nodeLabel} is offline. No data received for over 60 seconds.`);
      toast({
        variant: "destructive",
        title: `📡 Node Offline — ${nodeLabel}`,
        description: `${nodeLabel} has not sent data for over 60 seconds. Check device power and LoRa connection.`,
        duration: 12000,
      });
    },
    [playBeep, speak]
  );

  return { triggerAlarm, triggerNodeOffline };
};
