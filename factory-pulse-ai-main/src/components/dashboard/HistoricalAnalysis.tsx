import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Play, Pause, SkipForward, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import API, { freshQueryParams } from "@/api/api";
import { formatChartTime, parseServerDateTime } from "@/lib/dateTime";

const DEFAULT_NODES = ["NODE_01", "NODE_02", "NODE_03"];

type HistoricalPoint = {
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

const timeRanges = [
  { value: "1h", label: "1 Hour" },
  { value: "24h", label: "24 Hours" },
];

type HistoricalAnalysisProps = {
  forcedNode?: string | null;
};

const HistoricalAnalysis = ({ forcedNode }: HistoricalAnalysisProps) => {
  const [selectedRange, setSelectedRange] = useState("1h");
  const [allData, setAllData] = useState<HistoricalPoint[]>([]);
  const [selectedNode, setSelectedNode] = useState("ALL");
  const [availableNodes, setAvailableNodes] = useState<string[]>(DEFAULT_NODES);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPosition, setPlaybackPosition] = useState([0]);

  useEffect(() => {
    const fetchHistorical = async () => {
      try {
        const res = await API.get("/sensor-data", { params: freshQueryParams() });
        let rows: any[] = res.data || [];

        // Time range filter client-side (API already limit 100/200)
        const now = Date.now();
        if (selectedRange === "1h") {
          const oneHourAgo = new Date(now - 60 * 60 * 1000);
          rows = rows.filter(
            (item) => parseServerDateTime(item.created_at).getTime() >= oneHourAgo.getTime()
          );
        } else if (selectedRange === "24h") {
          const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
          rows = rows.filter(
            (item) => parseServerDateTime(item.created_at).getTime() >= oneDayAgo.getTime()
          );
        }

        const chartData: HistoricalPoint[] = rows
          .map((item) => ({
            node_id: String(item.node_id || "UNKNOWN"),
            time: formatChartTime(item.created_at || Date.now()),
            vibration: Number(item.vib_magnitude ?? item.vib ?? 0),
            distance: Number(item.distance ?? 0),
            anomaly:
              item.anomaly === 1 ||
              item.anomaly === true ||
              item.anomaly_edge === true
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
          }))
          .reverse(); // purana left side, naya right side

        setAllData(chartData);
        const discovered = Array.from(new Set(chartData.map((row) => row.node_id).filter(Boolean)));
        const merged = [...DEFAULT_NODES, ...discovered.filter((n) => !DEFAULT_NODES.includes(n))];
        setAvailableNodes(merged.slice(0, 4));
      } catch (err) {
        console.error("HistoricalAnalysis fetch error:", err);
      }
    };

    fetchHistorical();
    const interval = setInterval(fetchHistorical, 8000);
    return () => clearInterval(interval);
  }, [selectedRange]);

  useEffect(() => {
    if (selectedNode !== "ALL" && !availableNodes.includes(selectedNode)) {
      setSelectedNode("ALL");
    }
  }, [availableNodes, selectedNode]);

  const effectiveNode = forcedNode || selectedNode;
  const data = effectiveNode === "ALL" ? allData : allData.filter((row) => row.node_id === effectiveNode);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="glass-card p-6"
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <h3 className="font-semibold text-lg">Historical Analysis</h3>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
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

        <Tabs value={selectedRange} onValueChange={setSelectedRange}>
          <TabsList className="bg-muted/50">
            {timeRanges.map(range => (
              <TabsTrigger key={range.value} value={range.value} className="text-xs">
                {range.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        </div>
      </div>

      <div className="space-y-6 mb-6">
        {/* Main Sensors */}
        <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="time" tick={{ fontSize: 12 }} />
            <YAxis domain={[0, 12]} tick={{ fontSize: 12 }} />
            <Tooltip />
            <Line type="monotone" dataKey="vibration" stroke="hsl(var(--accent))" strokeWidth={2} dot={false} name="Vibration (g)" />
            <Line type="monotone" dataKey="distance" stroke="hsl(var(--neon-cyan))" strokeWidth={2} dot={false} name="Distance (cm)" />
            <Line type="stepAfter" dataKey="anomaly" stroke="hsl(var(--status-critical))" strokeWidth={2} dot={false} name="Anomaly" />
          </LineChart>
        </ResponsiveContainer>
        </div>

        {/* Smoke & Gas */}
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="time" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 1500]} tick={{ fontSize: 12 }} />
              <Tooltip />
              <ReferenceLine y={1200} stroke="#f59e0b" strokeDasharray="5 5" label="Smoke Alert" />
              <ReferenceLine y={400} stroke="#ef4444" strokeDasharray="5 5" label="Gas Alert" />
              <Line type="monotone" dataKey="smoke" stroke="#f59e0b" strokeWidth={2} dot={false} name="Smoke" />
              <Line type="monotone" dataKey="gas" stroke="#ef4444" strokeWidth={2} dot={false} name="Gas" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Flame */}
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="time" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 1]} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Line type="stepAfter" dataKey="flame" stroke="#ff6b00" strokeWidth={2} dot={false} name="Flame" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setIsPlaying(!isPlaying)}>
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8">
            <SkipForward className="w-4 h-4" />
          </Button>
        </div>
        <div className="flex-1">
          <Slider value={playbackPosition} onValueChange={setPlaybackPosition} max={100} step={1} />
        </div>
        <Button variant="outline" size="sm" className="h-8 gap-1">
          <Download className="w-3 h-3" />
          Export
        </Button>
      </div>
    </motion.div>
  );
};

export default HistoricalAnalysis;