import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import API, { freshQueryParams } from "@/api/api";
import { formatChartTime } from "@/lib/dateTime";
import { useAlarm } from "@/hooks/useAlarm";
import { useSensorSSE } from "@/hooks/useSensorSSE";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type LivePoint = {
  time: string;
  node_id: string;
  vibration: number;
  distance: number;
  anomaly: number;
  smoke: number;
  gas: number;
  flame: number;
  gatewayDistance: number;
  larsScore: number;
  retryCount: number;
};

type LiveChartsProps = {
  forcedNode?: string | null;
};

const LiveCharts = ({ forcedNode }: LiveChartsProps) => {
  const [allData, setAllData] = useState<LivePoint[]>([]);
  const [selectedNode, setSelectedNode] = useState("ALL");
  const [availableNodes, setAvailableNodes] = useState<string[]>(["NODE_01", "NODE_02", "NODE_03"]);
  const { triggerAlarm } = useAlarm();
  const { latestEvent } = useSensorSSE();

  const MAX_CHART_POINTS = 100;

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await API.get("/sensor-data", { params: freshQueryParams() });
        const recent = (res.data || []).slice(0, 100).reverse(); // latest -> oldest ko reverse karke left-to-right time

        const formatted: LivePoint[] = recent.map((item: any) => ({
          node_id: String(item.node_id || "UNKNOWN"),
          time: formatChartTime(item.created_at),
          // DB me "vib" column hai, agar future me vib_magnitude aaye to bhi support
          vibration: Number(item.vib_magnitude ?? item.vib ?? 0),
          distance: Number(item.distance ?? 0),
          // anomaly column (0/1 ya bool) ko high value pe map karo taaki line clearly dikhe
          anomaly:
            item.anomaly === 1 || item.anomaly === true || item.anomaly_edge === true
              ? 10
              : 0,
          smoke: Number(item.smoke ?? item.smoke_raw ?? 0),
          gas: Number(item.gas ?? item.gas_raw ?? 0),
          flame: Number(item.flame ?? 0),
          gatewayDistance: item.gateway_distance_exact_valid
            ? Number(item.gateway_distance_exact_m ?? 0)
            : Number(item.gateway_distance_estimate_m ?? 0),
          larsScore: Number(item.lars_score ?? 0),
          retryCount: Number(item.retry_count ?? 0),
        }));

        setAllData(formatted);

        const discovered = Array.from(
          new Set(
            formatted
              .map((row) => row.node_id)
              .filter(Boolean)
          )
        );
        const merged = ["NODE_01", "NODE_02", "NODE_03", ...discovered.filter((n) => !["NODE_01", "NODE_02", "NODE_03"].includes(n))];
        setAvailableNodes(merged.slice(0, 4));

        // Check latest visible node data for alerts
        const sourceRows = forcedNode
          ? recent.filter((row: any) => String(row.node_id || "UNKNOWN") === forcedNode)
          : recent;
        if (sourceRows.length > 0) {
          const latest = sourceRows[sourceRows.length - 1];
          triggerAlarm({
            node_id: latest.node_id,
            distance: latest.distance,
            flame: latest.flame,
            gas: latest.gas ?? latest.gas_raw,
            smoke: latest.smoke ?? latest.smoke_raw,
          });
        }
      } catch (err) {
        console.error("LiveCharts fetch error:", err);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 10000); // Fallback REST poll — 10s
    return () => clearInterval(interval);
  }, [forcedNode, triggerAlarm]);

  // SSE: append incoming data point instantly
  useEffect(() => {
    if (!latestEvent || latestEvent.type !== "sensor_data" || !latestEvent.node_id) return;
    const evt = latestEvent;
    const nodeId = evt.node_id;
    if (forcedNode && nodeId !== forcedNode) return;

    const newPoint: LivePoint = {
      node_id:  nodeId,
      time:     formatChartTime(evt.created_at ?? new Date().toISOString()),
      vibration:     Number(evt.vib      ?? 0),
      distance:      Number(evt.distance ?? 0),
      anomaly:       (evt.anomaly === true || (evt.anomaly as any) === 1) ? 10 : 0,
      smoke:         Number(evt.smoke    ?? 0),
      gas:           Number(evt.gas      ?? 0),
      flame:         Number(evt.flame    ?? 0),
      gatewayDistance: Number(evt.gateway_distance_estimate_m ?? 0),
      larsScore:     Number(evt.lars_score  ?? 0),
      retryCount:    Number(evt.retry_count ?? 0),
    };

    setAllData(prev => {
      const next = [...prev, newPoint];
      // Keep last MAX_CHART_POINTS to prevent unbounded growth
      return next.length > MAX_CHART_POINTS ? next.slice(next.length - MAX_CHART_POINTS) : next;
    });
  }, [latestEvent, forcedNode]);

  const effectiveNode = forcedNode || selectedNode;
  const data = effectiveNode === "ALL" ? allData : allData.filter((row) => row.node_id === effectiveNode);
  const latest = data[data.length - 1];

  return (
    <div className="space-y-4">
      <div className="glass-card p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="font-semibold">Live Node View</h3>
          {forcedNode ? (
            <div className="text-xs rounded-md px-2 py-1 bg-muted/50">Node: {forcedNode}</div>
          ) : (
            <Tabs value={selectedNode} onValueChange={setSelectedNode}>
              <TabsList className="bg-muted/50">
                <TabsTrigger value="ALL" className="text-xs">All</TabsTrigger>
                {availableNodes.map((node) => (
                  <TabsTrigger key={node} value={node} className="text-xs">
                    {node}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
      {/* Vibration & Anomaly */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="glass-card p-6"
      >
        <h3 className="font-semibold mb-4">Vibration & Anomaly</h3>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="time" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 12]} tick={{ fontSize: 12 }} />
              <Tooltip />
              <ReferenceLine y={9.5} stroke="red" strokeDasharray="5 5" label="Critical" />
              <Area
                type="monotone"
                dataKey="vibration"
                stroke="#8b5cf6"
                fill="#8b5cf6"
                fillOpacity={0.25}
                name="Vib (g)"
              />
              <Area
                type="stepAfter"
                dataKey="anomaly"
                stroke="red"
                fill="none"
                name="Anomaly"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </motion.div>

      {/* Distance */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="glass-card p-6"
      >
        <h3 className="font-semibold mb-4">Distance Sensor (cm)</h3>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="time" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 70]} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Area
                type="monotone"
                dataKey="distance"
                stroke="#06b6d4"
                fill="#06b6d4"
                fillOpacity={0.25}
                name="Distance"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </motion.div>

      {/* Smoke & Gas */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="glass-card p-6"
      >
        <h3 className="font-semibold mb-4">Smoke & Gas</h3>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="time" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 1500]} tick={{ fontSize: 12 }} />
              <Tooltip />
              <ReferenceLine y={1200} stroke="#f59e0b" strokeDasharray="5 5" label="Smoke Alert" />
              <ReferenceLine y={400} stroke="#ef4444" strokeDasharray="5 5" label="Gas Alert" />
              <Area
                type="monotone"
                dataKey="smoke"
                stroke="#f59e0b"
                fill="#f59e0b"
                fillOpacity={0.25}
                name="Smoke"
              />
              <Area
                type="monotone"
                dataKey="gas"
                stroke="#ef4444"
                fill="#ef4444"
                fillOpacity={0.25}
                name="Gas"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 text-xs text-center text-muted-foreground">
          Smoke Alert: 1200 | Gas Alert: 400
        </div>
      </motion.div>

      {/* Flame Detection */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.3 }}
        className="glass-card p-6"
      >
        <h3 className="font-semibold mb-4">Flame Detection</h3>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="time" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 1]} tick={{ fontSize: 12 }} />
              <Tooltip />
              <ReferenceLine y={0.5} stroke="red" strokeDasharray="5 5" label="Alert" />
              <Area
                type="stepAfter"
                dataKey="flame"
                stroke="#ff6b00"
                fill="#ff6b00"
                fillOpacity={0.4}
                name="Flame"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 text-sm text-center">
          <span className="font-semibold">Status: </span>
          <span className={latest?.flame ? "text-red-500 font-bold" : "text-green-500"}>
            {latest?.flame ? "FLAME DETECTED!" : "No Flame"}
          </span>
        </div>
      </motion.div>
      </div>
    </div>
  );
};

export default LiveCharts;