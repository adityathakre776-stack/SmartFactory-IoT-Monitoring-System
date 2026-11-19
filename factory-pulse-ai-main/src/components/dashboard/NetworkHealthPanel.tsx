import { useEffect, useState } from "react";
import API from "@/api/api";
import { useSensorSSE } from "@/hooks/useSensorSSE";
import { Wifi, WifiOff } from "lucide-react";

type LinkRow = {
  node_id: string;
  rows_10m: number;
  last_seen: string | null;
  link_quality: "strong" | "moderate" | "weak";
  gateway_distance_estimate_m?: number;
  gateway_distance_exact_m?: number;
  gateway_distance_exact_valid?: boolean;
  distance_method?: string;
  lars_score?: number;
  retry_count?: number;
  delivery_status?: string;
  packet_failure?: string;
  acked_packets_total?: number;
  dropped_packets_total?: number;
  ack_timeouts_total?: number;
};

type FactoryProfile = {
  factory_name: string;
  industry: string;
  zones: { id: string; name: string }[];
};

const badge = {
  strong: "bg-emerald-500/10 text-emerald-500",
  moderate: "bg-amber-500/10 text-amber-500",
  weak: "bg-red-500/10 text-red-500",
};

type NetworkHealthPanelProps = {
  forcedNode?: string | null;
};

const NetworkHealthPanel = ({ forcedNode }: NetworkHealthPanelProps) => {
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [profile, setProfile] = useState<FactoryProfile | null>(null);
  const { nodeStatuses, isConnected } = useSensorSSE();

  useEffect(() => {
    const load = async () => {
      try {
        const [h, p] = await Promise.all([
          API.get("/network-health"),
          API.get("/factory-profile"),
        ]);
        setLinks(h.data || []);
        setProfile(p.data || null);
      } catch (e) {
        console.error("Network panel load failed", e);
      }
    };
    load();
    const i = setInterval(load, 10000);
    return () => clearInterval(i);
  }, []);

  const visibleLinks = forcedNode
    ? links.filter((link) => link.node_id === forcedNode)
    : links;

  return (
    <div className="glass-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Factory Profile</h3>
          <p className="text-sm text-muted-foreground">
            {profile?.factory_name || "ApexChem Blending Works"} - {profile?.industry || "Chemical Blending"}
          </p>
        </div>
        {/* SSE live indicator */}
        <div className="flex items-center gap-1.5 text-xs">
          {isConnected ? (
            <><Wifi className="w-3 h-3 text-emerald-500" /><span className="text-emerald-500 font-semibold">LIVE</span></>
          ) : (
            <><WifiOff className="w-3 h-3 text-amber-400" /><span className="text-amber-400 font-semibold">POLLING</span></>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(profile?.zones || []).map((z) => (
          <div key={z.id} className="rounded-md border border-border p-2 text-sm">
            <div className="font-medium">{z.id}</div>
            <div className="text-muted-foreground">{z.name}</div>
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <h4 className="font-medium">LoRa Link Health (last 10 min)</h4>
        {visibleLinks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent packets.</p>
        ) : (
          visibleLinks.map((r) => (
            <div key={r.node_id} className="flex items-center justify-between border border-border rounded-md px-3 py-2 text-sm">
              <div>
                <div className="flex items-center gap-2 font-medium">
                  {/* Node online dot from SSE */}
                  {(() => {
                    const ns = nodeStatuses[r.node_id];
                    const online = ns?.online ?? false;
                    return (
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${online ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} title={online ? "Online" : "Offline"} />
                    );
                  })()}
                  {r.node_id}
                </div>
                <div className="text-muted-foreground">{r.rows_10m} packets / 10m</div>
                <div className="text-muted-foreground">
                  Gateway Dist:{" "}
                  {r.gateway_distance_exact_valid
                    ? `${Number(r.gateway_distance_exact_m || 0).toFixed(1)} m`
                    : `${Number(r.gateway_distance_estimate_m || 0).toFixed(1)} m est.`}
                </div>
                <div className="text-muted-foreground">
                  LARS: {r.lars_score || 0} | Retry: {r.retry_count || 0} | {r.delivery_status || "UNKNOWN"}
                </div>
                <div className="text-muted-foreground">
                  Fail Risk: {(r.packet_failure || "unknown").toUpperCase()} | ACK TO: {r.ack_timeouts_total || 0}
                </div>
              </div>
              <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${badge[r.link_quality]}`}>
                {r.link_quality.toUpperCase()}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default NetworkHealthPanel;
