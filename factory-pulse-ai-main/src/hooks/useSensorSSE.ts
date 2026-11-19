/**
 * useSensorSSE — Real-time sensor data via Server-Sent Events
 *
 * Connects to Flask /api/stream and pushes live updates to the dashboard.
 * Falls back gracefully to the existing REST polling if SSE is unavailable.
 *
 * Usage:
 *   const { latestEvent, nodeStatuses, isConnected } = useSensorSSE();
 */

import { useState, useEffect, useRef, useCallback } from "react";

export type NodeStatus = {
  online: boolean;
  last_seen: string | null;
  elapsed_sec: number | null;
};

export type NodeStatuses = {
  NODE_01: NodeStatus;
  NODE_02: NodeStatus;
  NODE_03: NodeStatus;
  [key: string]: NodeStatus;
};

export type SensorEvent = {
  type: "sensor_data" | "node_status";
  node_id?: string;
  seq?: number;
  smoke?: number;
  gas?: number;
  flame?: number;
  distance?: number;
  vib?: number;
  ax?: number;
  ay?: number;
  az?: number;
  lat?: number;
  lon?: number;
  anomaly?: boolean;
  gateway_rssi?: number;
  gateway_snr?: number;
  gateway_distance_estimate_m?: number;
  lars_score?: number;
  retry_count?: number;
  delivery_status?: string;
  acked?: boolean;
  created_at?: string;
  statuses?: NodeStatuses;
};

const DEFAULT_NODE_STATUS: NodeStatus = {
  online: false,
  last_seen: null,
  elapsed_sec: null,
};

const DEFAULT_STATUSES: NodeStatuses = {
  NODE_01: { ...DEFAULT_NODE_STATUS },
  NODE_02: { ...DEFAULT_NODE_STATUS },
  NODE_03: { ...DEFAULT_NODE_STATUS },
};

const SSE_RECONNECT_MS = 3000;
const OFFLINE_THRESHOLD_SEC = 60;

function getApiBase(): string {
  const saved = typeof window !== "undefined" ? localStorage.getItem("apiBaseUrl") : null;
  if (saved) {
    // Convert /api path to base
    return saved.replace(/\/api$/, "");
  }
  const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
  return `http://${host}:5000`;
}

export function useSensorSSE() {
  const [latestEvent, setLatestEvent] = useState<SensorEvent | null>(null);
  const [nodeStatuses, setNodeStatuses] = useState<NodeStatuses>({ ...DEFAULT_STATUSES });
  const [isConnected, setIsConnected] = useState(false);
  const [sseSupported, setSseSupported] = useState(true);

  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeenRef = useRef<Record<string, number>>({});

  // Update nodeStatuses when sensor_data events arrive (track last seen per node)
  const handleSensorData = useCallback((evt: SensorEvent) => {
    const nodeId = evt.node_id;
    if (!nodeId) return;

    const now = Date.now() / 1000;
    lastSeenRef.current[nodeId] = now;

    setLatestEvent(evt);

    // Update online status for this node
    setNodeStatuses((prev) => ({
      ...prev,
      [nodeId]: {
        online: true,
        last_seen: evt.created_at ?? new Date().toISOString(),
        elapsed_sec: 0,
      },
    }));
  }, []);

  const handleNodeStatus = useCallback((statuses: NodeStatuses) => {
    setNodeStatuses((prev) => {
      const merged = { ...prev };
      for (const [nodeId, status] of Object.entries(statuses)) {
        merged[nodeId] = status;
      }
      return merged;
    });
  }, []);

  const connect = useCallback(() => {
    if (!("EventSource" in window)) {
      setSseSupported(false);
      return;
    }

    if (esRef.current) {
      esRef.current.close();
    }

    const base = getApiBase();
    const url = `${base}/api/stream`;

    try {
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        setIsConnected(true);
        if (reconnectTimer.current) {
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = null;
        }
      };

      es.onmessage = (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data) as SensorEvent;
          if (data.type === "sensor_data") {
            handleSensorData(data);
          } else if (data.type === "node_status" && data.statuses) {
            handleNodeStatus(data.statuses);
          }
        } catch {
          // Ignore malformed events
        }
      };

      es.onerror = () => {
        setIsConnected(false);
        es.close();
        esRef.current = null;
        // Schedule reconnect
        reconnectTimer.current = setTimeout(connect, SSE_RECONNECT_MS);
      };
    } catch {
      setSseSupported(false);
    }
  }, [handleSensorData, handleNodeStatus]);

  // Elapsed-sec ticker — update every 5s so UI shows "X sec ago"
  useEffect(() => {
    const ticker = setInterval(() => {
      const now = Date.now() / 1000;
      setNodeStatuses((prev) => {
        const next = { ...prev };
        for (const nodeId of Object.keys(lastSeenRef.current)) {
          const last = lastSeenRef.current[nodeId];
          const elapsed = now - last;
          next[nodeId] = {
            ...next[nodeId],
            online: elapsed < OFFLINE_THRESHOLD_SEC,
            elapsed_sec: Math.round(elapsed),
          };
        }
        return next;
      });
    }, 5000);
    return () => clearInterval(ticker);
  }, []);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
      esRef.current = null;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);

  return { latestEvent, nodeStatuses, isConnected, sseSupported };
}
