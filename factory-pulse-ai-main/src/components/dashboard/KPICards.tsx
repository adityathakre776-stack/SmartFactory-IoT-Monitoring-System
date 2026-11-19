import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Activity, Brain, Zap, Shield, TrendingUp, TrendingDown, Minus, Wifi, WifiOff } from "lucide-react";
import API, { freshQueryParams } from "@/api/api";
import { useSensorSSE } from "@/hooks/useSensorSSE";
import { useAlarm } from "@/hooks/useAlarm";

const DEFAULT_NODES = ["NODE_01", "NODE_02", "NODE_03"];

type SensorRow = {
  node_id?: string;
  vib_magnitude?: number;
  vib?: number;
  anomaly_edge?: boolean;
  anomaly?: number | boolean;
  distance?: number;
  smoke?: number;
  smoke_raw?: number;
  gas?: number;
  gas_raw?: number;
  flame?: number;
  gateway_distance_estimate_m?: number;
  gateway_distance_exact_m?: number;
  gateway_distance_exact_valid?: boolean;
  lars_score?: number;
  retry_count?: number;
  delivery_status?: string;
  acked?: boolean;
  dropped_packets_total?: number;
  ack_timeouts_total?: number;
};

type NodeSummary = {
  nodeId: string;
  vib: number;
  distance: number;
  smoke: number;
  gas: number;
  flame: number;
  anomaly: boolean;
  gatewayDistance: number;
  gatewayDistanceIsExact: boolean;
  larsScore: number;
  retryCount: number;
  deliveryStatus: string;
  acked: boolean;
  droppedPacketsTotal: number;
  ackTimeoutsTotal: number;
};

const KPICard = ({ title, icon: Icon, value, subValue, gauge, trend, status, color, delay }) => {
  const statusBadge = {
    normal: { bg: "bg-emerald-500/10", text: "text-emerald-500", label: "NORMAL" },
    warning: { bg: "bg-amber-500/10", text: "text-amber-500", label: "CAUTION" },
    critical: { bg: "bg-red-500/10", text: "text-red-500", label: "CRITICAL" },
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay }}
      whileHover={{ y: -4 }}
      className="glass-card p-5 group"
    >
      <div className="flex items-start justify-between mb-3">
        <div className={`p-2.5 rounded-xl ${color} bg-opacity-10 group-hover:scale-110 transition-transform`}>
          <Icon className={`w-5 h-5 ${color.replace('bg-', 'text-')}`} />
        </div>
        {trend && (
          <div className={`flex items-center gap-1 text-sm ${trend.direction === "up" ? "text-emerald-500" : trend.direction === "down" ? "text-red-500" : "text-gray-400"}`}>
            {trend.direction === "up" && <TrendingUp className="w-4 h-4" />}
            {trend.direction === "down" && <TrendingDown className="w-4 h-4" />}
            {trend.direction === "neutral" && <Minus className="w-4 h-4" />}
            <span className="font-medium">{trend.value}</span>
          </div>
        )}
        {status && (
          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${statusBadge[status].bg} ${statusBadge[status].text}`}>
            {statusBadge[status].label}
          </span>
        )}
      </div>
      <div className="mb-2">
        <span className="text-2xl font-bold">{value}</span>
        {subValue && <span className="text-gray-400 ml-2 text-sm">{subValue}</span>}
      </div>
      <div className="text-sm text-gray-400 mb-3">{title}</div>
      {gauge !== undefined && (
        <div className="relative h-2 bg-gray-800 rounded-full overflow-hidden">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${gauge}%` }}
            transition={{ duration: 1.2, delay: delay + 0.3, ease: "easeOut" }}
            className={`absolute left-0 top-0 h-full rounded-full ${gauge >= 80 ? 'bg-emerald-500' : gauge >= 50 ? 'bg-amber-500' : 'bg-red-500'}`}
          />
          <span className="absolute right-2 -top-5 text-xs text-gray-400">{gauge.toFixed(0)}%</span>
        </div>
      )}
    </motion.div>
  );
};

type KPICardsProps = {
  forcedNode?: string | null;
  onNodeClick?: (nodeId: string) => void;
};

const KPICards = ({ forcedNode, onNodeClick }: KPICardsProps) => {
  const [latest, setLatest] = useState<SensorRow | null>(null);
  const [nodeSummaries, setNodeSummaries] = useState<NodeSummary[]>([]);
  const { latestEvent, nodeStatuses, isConnected } = useSensorSSE();
  const { triggerAlarm, triggerNodeOffline } = useAlarm();
  const alreadyOfflineRef = useRef<Record<string, boolean>>({});

  const formatRows = (rows: SensorRow[]) => {
    const latestByNode = new Map<string, SensorRow>();

    for (const row of rows) {
      const nodeId = String(row.node_id || "").trim();
      if (!nodeId || latestByNode.has(nodeId)) continue;
      latestByNode.set(nodeId, row);
    }

    const discoveredNodes = Array.from(latestByNode.keys());
    const orderedNodes = [...DEFAULT_NODES, ...discoveredNodes.filter((n) => !DEFAULT_NODES.includes(n))];

    const visibleNodes = forcedNode ? [forcedNode] : orderedNodes;
    const summaries = visibleNodes
      .map((nodeId) => {
        const row = latestByNode.get(nodeId);
        if (!row) {
          return {
            nodeId,
            vib: 0,
            distance: 0,
            smoke: 0,
            gas: 0,
            flame: 0,
            anomaly: false,
            gatewayDistance: 0,
            gatewayDistanceIsExact: false,
            larsScore: 0,
            retryCount: 0,
            deliveryStatus: "NO_DATA",
            acked: false,
            droppedPacketsTotal: 0,
            ackTimeoutsTotal: 0,
          };
        }
        return {
          nodeId,
          vib: Number(row.vib_magnitude ?? row.vib ?? 0),
          distance: Number(row.distance ?? 0),
          smoke: Number(row.smoke ?? row.smoke_raw ?? 0),
          gas: Number(row.gas ?? row.gas_raw ?? 0),
          flame: Number(row.flame ?? 0),
          anomaly: row.anomaly_edge === true || row.anomaly === 1 || row.anomaly === true,
          gatewayDistance: row.gateway_distance_exact_valid
            ? Number(row.gateway_distance_exact_m ?? 0)
            : Number(row.gateway_distance_estimate_m ?? 0),
          gatewayDistanceIsExact: row.gateway_distance_exact_valid === true,
          larsScore: Number(row.lars_score ?? 0),
          retryCount: Number(row.retry_count ?? 0),
          deliveryStatus: String(row.delivery_status ?? "UNKNOWN"),
          acked: row.acked !== false,
          droppedPacketsTotal: Number(row.dropped_packets_total ?? 0),
          ackTimeoutsTotal: Number(row.ack_timeouts_total ?? 0),
        };
      })
      .slice(0, 3);

    setNodeSummaries(summaries);
  };

  // SSE real-time update: merge a single incoming node's data instantly
  useEffect(() => {
    if (!latestEvent || latestEvent.type !== "sensor_data" || !latestEvent.node_id) return;
    const evt = latestEvent;
    const nodeId = evt.node_id;
    // Skip if forcedNode is set and this event is for a different node
    if (forcedNode && nodeId !== forcedNode) return;

    const newRow: SensorRow = {
      node_id:     nodeId,
      vib:         evt.vib ?? 0,
      vib_magnitude: evt.vib ?? 0,
      flame:       evt.flame ?? 0,
      smoke:       evt.smoke ?? 0,
      gas:         evt.gas   ?? 0,
      distance:    evt.distance ?? 0,
      anomaly:     evt.anomaly ? 1 : 0,
      gateway_distance_estimate_m: evt.gateway_distance_estimate_m ?? 0,
      lars_score:  evt.lars_score ?? 0,
      retry_count: evt.retry_count ?? 0,
      delivery_status: evt.delivery_status ?? "LIVE",
      acked:       evt.acked !== false,
    };

    // Trigger alarm on live SSE data
    triggerAlarm(newRow);

    setNodeSummaries(prev => {
      const idx = prev.findIndex(s => s.nodeId === nodeId);
      const newSummary: NodeSummary = {
        nodeId,
        vib:      Number(newRow.vib ?? 0),
        distance: Number(newRow.distance ?? 0),
        smoke:    Number(newRow.smoke ?? 0),
        gas:      Number(newRow.gas   ?? 0),
        flame:    Number(newRow.flame ?? 0),
        anomaly:  newRow.anomaly === 1 || newRow.anomaly === true,
        gatewayDistance: Number(newRow.gateway_distance_estimate_m ?? 0),
        gatewayDistanceIsExact: false,
        larsScore:   Number(newRow.lars_score ?? 0),
        retryCount:  Number(newRow.retry_count ?? 0),
        deliveryStatus: String(newRow.delivery_status ?? "LIVE"),
        acked:       newRow.acked !== false,
        droppedPacketsTotal: 0,
        ackTimeoutsTotal: 0,
      };
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = newSummary;
        return next;
      }
      return [...prev, newSummary];
    });

    if (latest === null || String((latest as any).node_id) === nodeId) {
      setLatest(newRow);
    }
  }, [latestEvent, forcedNode, triggerAlarm]);

  // Offline alert: fire when a node transitions to offline
  useEffect(() => {
    const NODES = ["NODE_01", "NODE_02", "NODE_03"];
    for (const nodeId of NODES) {
      const status = nodeStatuses[nodeId];
      if (!status) continue;
      if (!status.online && (status.elapsed_sec ?? 0) > 60) {
        if (!alreadyOfflineRef.current[nodeId]) {
          alreadyOfflineRef.current[nodeId] = true;
          triggerNodeOffline(nodeId);
        }
      } else {
        alreadyOfflineRef.current[nodeId] = false;
      }
    }
  }, [nodeStatuses, triggerNodeOffline]);

  useEffect(() => {
    const fetchLatest = async () => {
      try {
        const res = await API.get("/sensor-data", { params: freshQueryParams() });
        if (res.data?.length > 0) {
          const rows = res.data as SensorRow[];
          const visibleRows = forcedNode
            ? rows.filter((row) => String(row.node_id || "") === forcedNode)
            : rows;
          setLatest(visibleRows[0] || rows[0]); // latest first (DESC order)
          formatRows(rows);
        }
      } catch (err) {
        console.error("Sensor fetch error:", err);
      }
    };

    fetchLatest();
    const interval = setInterval(fetchLatest, 3000); // har 3 sec update
    return () => clearInterval(interval);
  }, [forcedNode]);

  const effectiveLatest =
    forcedNode && nodeSummaries.length > 0
      ? {
          vib: nodeSummaries[0].vib,
          anomaly: nodeSummaries[0].anomaly,
          distance: nodeSummaries[0].distance,
          smoke: nodeSummaries[0].smoke,
          gas: nodeSummaries[0].gas,
          flame: nodeSummaries[0].flame,
          gatewayDistance: nodeSummaries[0].gatewayDistance,
          gatewayDistanceIsExact: nodeSummaries[0].gatewayDistanceIsExact,
          larsScore: nodeSummaries[0].larsScore,
          retryCount: nodeSummaries[0].retryCount,
          deliveryStatus: nodeSummaries[0].deliveryStatus,
          acked: nodeSummaries[0].acked,
          droppedPacketsTotal: nodeSummaries[0].droppedPacketsTotal,
          ackTimeoutsTotal: nodeSummaries[0].ackTimeoutsTotal,
        }
      : null;

  const vib = effectiveLatest ? Number(effectiveLatest.vib) : latest ? Number(latest.vib_magnitude || latest.vib || 0) : 0;
  const anomaly = effectiveLatest ? !!effectiveLatest.anomaly : latest?.anomaly_edge === true || latest?.anomaly === 1;
  const distance = effectiveLatest ? Number(effectiveLatest.distance) : latest ? Number(latest.distance || 0) : 0;
  const smoke = effectiveLatest ? Number(effectiveLatest.smoke) : latest ? Number(latest.smoke || latest.smoke_raw || 0) : 0;
  const gas = effectiveLatest ? Number(effectiveLatest.gas) : latest ? Number(latest.gas || latest.gas_raw || 0) : 0;
  const flame = effectiveLatest ? Number(effectiveLatest.flame) : latest ? Number(latest.flame || 0) : 0;
  const gatewayDistance = effectiveLatest
    ? Number(effectiveLatest.gatewayDistance)
    : latest
      ? (latest.gateway_distance_exact_valid ? Number(latest.gateway_distance_exact_m || 0) : Number(latest.gateway_distance_estimate_m || 0))
      : 0;
  const gatewayDistanceIsExact = effectiveLatest
    ? !!effectiveLatest.gatewayDistanceIsExact
    : latest?.gateway_distance_exact_valid === true;
  const larsScore = effectiveLatest ? Number(effectiveLatest.larsScore) : latest ? Number(latest.lars_score || 0) : 0;
  const retryCount = effectiveLatest ? Number(effectiveLatest.retryCount) : latest ? Number(latest.retry_count || 0) : 0;
  const deliveryStatus = effectiveLatest ? String(effectiveLatest.deliveryStatus) : String(latest?.delivery_status || "UNKNOWN");
  const droppedPacketsTotal = effectiveLatest ? Number(effectiveLatest.droppedPacketsTotal) : latest ? Number(latest.dropped_packets_total || 0) : 0;
  const ackTimeoutsTotal = effectiveLatest ? Number(effectiveLatest.ackTimeoutsTotal) : latest ? Number(latest.ack_timeouts_total || 0) : 0;

  // Updated thresholds
  const GAS_THRESHOLD = 400;
  const SMOKE_THRESHOLD = 1200;

  const vibGauge = Math.min(100, (vib / 10) * 100); // 10g max assume
  const distanceGauge = Math.min(100, (distance / 100) * 100); // 100cm max

  return (
    <div className="space-y-4">
      {/* SSE connection indicator */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {isConnected ? (
          <><Wifi className="w-3 h-3 text-emerald-500" /><span className="text-emerald-500 font-medium">LIVE</span></>
        ) : (
          <><WifiOff className="w-3 h-3 text-amber-500" /><span className="text-amber-500 font-medium">POLLING</span></>
        )}
        <span>Real-time node status</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {nodeSummaries.map((node, idx) => (
          <motion.div
            key={node.nodeId}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: idx * 0.08 }}
            className={`glass-card p-4 ${!forcedNode ? "cursor-pointer hover:border-primary/50 transition-colors" : ""}`}
            role={!forcedNode ? "button" : undefined}
            tabIndex={!forcedNode ? 0 : undefined}
            onClick={!forcedNode && onNodeClick ? () => onNodeClick(node.nodeId) : undefined}
            onKeyDown={
              !forcedNode && onNodeClick
                ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onNodeClick(node.nodeId);
                    }
                  }
                : undefined
            }
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {/* Online/Offline indicator */}
                {(() => {
                  const ns = nodeStatuses[node.nodeId];
                  const isOnline = ns?.online ?? false;
                  const elapsed = ns?.elapsed_sec;
                  return (
                    <div className="flex items-center gap-1" title={isOnline ? `Last seen ${elapsed ?? 0}s ago` : "Offline"}>
                      <span className={`w-2 h-2 rounded-full ${isOnline ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} />
                      <span className={`text-xs font-medium ${isOnline ? "text-emerald-500" : "text-red-500"}`}>
                        {isOnline ? `${elapsed ?? 0}s` : "OFFLINE"}
                      </span>
                    </div>
                  );
                })()}
                <h4 className="font-semibold">{node.nodeId}</h4>
              </div>
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  node.anomaly ? "bg-red-500/10 text-red-500" : "bg-emerald-500/10 text-emerald-500"
                }`}
              >
                {node.anomaly ? "ALERT" : "NORMAL"}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <div>Dist: {node.distance.toFixed(1)} cm</div>
              <div>Vib: {node.vib.toFixed(2)} g</div>
              <div>Smoke: {node.smoke.toFixed(0)}</div>
              <div>Gas: {node.gas.toFixed(0)}</div>
              <div>Flame: {node.flame > 0 ? "Yes" : "No"}</div>
              <div>GW: {node.gatewayDistance.toFixed(1)} m{node.gatewayDistanceIsExact ? "" : "*"}</div>
              <div>LARS: {node.larsScore}</div>
              <div>Retry: {node.retryCount}</div>
              <div>{node.deliveryStatus}</div>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
      <KPICard
        title="Vibration Magnitude"
        icon={Activity}
        value={`${vib.toFixed(2)} g`}
        trend={{ value: vib > 9.5 ? "+High" : "Stable", direction: vib > 9.5 ? "up" : "neutral" }}
        gauge={vibGauge}
        color="bg-purple-600"
        delay={0} subValue={undefined} status={undefined}      />
      <KPICard
        title="Anomaly Detected"
        icon={Brain}
        value={anomaly ? "YES" : "NO"}
        status={anomaly ? "critical" : "normal"}
        color={anomaly ? "bg-red-600" : "bg-emerald-600"}
        delay={0.1} subValue={undefined} gauge={undefined} trend={undefined}      />
      <KPICard
        title="Distance Sensor"
        icon={Zap}
        value={`${distance.toFixed(1)} cm`}
        gauge={distanceGauge}
        color="bg-cyan-600"
        delay={0.2} subValue={undefined} trend={undefined} status={undefined}      />
      <KPICard
        title="Gateway Distance"
        icon={Zap}
        value={`${gatewayDistance.toFixed(1)} m`}
        subValue={gatewayDistanceIsExact ? "exact" : "estimated"}
        color={gatewayDistanceIsExact ? "bg-emerald-600" : "bg-amber-600"}
        delay={0.25} gauge={undefined} trend={undefined} status={undefined} />
      <KPICard
        title="Smoke Level"
        icon={Shield}
          value={smoke > SMOKE_THRESHOLD ? "High" : "Normal"}
          status={smoke > SMOKE_THRESHOLD ? "warning" : "normal"}
          color={smoke > SMOKE_THRESHOLD ? "bg-amber-600" : "bg-emerald-600"}
        delay={0.3} subValue={undefined} gauge={undefined} trend={undefined}      />
        <KPICard
          title="Gas Level"
          icon={Shield}
          value={gas > GAS_THRESHOLD ? "High" : "Normal"}
          status={gas > GAS_THRESHOLD ? "warning" : "normal"}
          color={gas > GAS_THRESHOLD ? "bg-red-600" : "bg-emerald-600"}
          delay={0.4} subValue={undefined} gauge={undefined} trend={undefined}      />
        <KPICard
          title="Link Health"
          icon={Shield}
          value={`LARS ${larsScore}`}
          subValue={`${deliveryStatus} | R${retryCount} | D${droppedPacketsTotal}/TO${ackTimeoutsTotal}`}
          status={larsScore >= 75 ? "normal" : larsScore >= 45 ? "warning" : "critical"}
          color={larsScore >= 75 ? "bg-emerald-600" : larsScore >= 45 ? "bg-amber-600" : "bg-red-600"}
          delay={0.5} gauge={undefined} trend={undefined}      />
      </div>
    </div>
  );
};

export default KPICards;