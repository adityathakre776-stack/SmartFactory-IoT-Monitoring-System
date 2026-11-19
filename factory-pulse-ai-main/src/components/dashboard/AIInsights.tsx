import { motion } from "framer-motion";
import { AlertTriangle, Lightbulb, Check, Clock, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

const issues = [
  {
    id: 1,
    node: "ZONE_1 Mixer Pump",
    issue: "Vibration rising with solvent load",
    severity: "warning",
    time: "2 min ago",
    details: "RMS vibration trend crossed baseline by 22% in last 30 min",
  },
  {
    id: 2,
    node: "ZONE_2 Filling Line",
    issue: "Gas concentration rising near drum valves",
    severity: "critical",
    time: "5 min ago",
    details: "Gas trend sustained above warning threshold",
  },
  {
    id: 3,
    node: "ZONE_3 Dispatch",
    issue: "Proximity hazard near moving drums",
    severity: "info",
    time: "15 min ago",
    details: "Distance repeatedly below 30cm during handling cycle",
  },
];

const recommendations = [
  {
    id: 1,
    title: "Inspect mixer coupler in ZONE_1",
    description: "Rising vibration suggests early misalignment; inspect before next shift",
    priority: "high",
    type: "Predictive Maintenance",
  },
  {
    id: 2,
    title: "Run leak check at valve manifold",
    description: "Gas trend and smoke co-rise pattern indicates possible micro-leak event",
    priority: "critical",
    type: "Safety",
  },
  {
    id: 3,
    title: "Re-route drum movement lane in dispatch",
    description: "Frequent low-distance alarms suggest unsafe path around active equipment.",
    priority: "low",
    type: "Maintenance",
  },
];

const severityColors = {
  critical: { bg: "bg-status-critical/10", text: "text-status-critical", dot: "bg-status-critical" },
  warning: { bg: "bg-status-warning/10", text: "text-status-warning", dot: "bg-status-warning" },
  info: { bg: "bg-neon-cyan/10", text: "text-neon-cyan", dot: "bg-neon-cyan" },
};

const priorityColors = {
  critical: "border-status-critical/30 bg-status-critical/5",
  high: "border-status-warning/30 bg-status-warning/5",
  medium: "border-neon-cyan/30 bg-neon-cyan/5",
  low: "border-muted-foreground/30 bg-muted/50",
};

const AIInsights = () => {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Top Issues */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.3 }}
        className="glass-card p-4"
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-status-warning" />
            <h3 className="font-semibold">Top Issues</h3>
          </div>
          <Button variant="ghost" size="sm" className="text-xs">
            View All
            <ArrowRight className="ml-1 w-3 h-3" />
          </Button>
        </div>

        <div className="space-y-3">
          {issues.map((issue, index) => (
            <motion.div
              key={issue.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 + index * 0.1 }}
              className={`p-3 rounded-lg border ${
                severityColors[issue.severity as keyof typeof severityColors].bg
              } border-border/50`}
            >
              <div className="flex items-start justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${
                    severityColors[issue.severity as keyof typeof severityColors].dot
                  }`} />
                  <span className="font-medium text-sm">{issue.node}</span>
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="w-3 h-3" />
                  {issue.time}
                </div>
              </div>
              <p className={`text-sm ${severityColors[issue.severity as keyof typeof severityColors].text}`}>
                {issue.issue}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{issue.details}</p>
            </motion.div>
          ))}
        </div>
      </motion.div>

      {/* AI Recommendations */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.4 }}
        className="glass-card p-4"
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Lightbulb className="w-5 h-5 text-accent" />
            <h3 className="font-semibold">AI Recommendations</h3>
          </div>
          <span className="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent">
            3 pending
          </span>
        </div>

        <div className="space-y-3">
          {recommendations.map((rec, index) => (
            <motion.div
              key={rec.id}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.5 + index * 0.1 }}
              className={`p-3 rounded-lg border ${priorityColors[rec.priority as keyof typeof priorityColors]}`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent font-medium">
                      {rec.type}
                    </span>
                  </div>
                  <h4 className="font-medium text-sm mb-1">{rec.title}</h4>
                  <p className="text-xs text-muted-foreground">{rec.description}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-status-normal hover:text-status-normal hover:bg-status-normal/10"
                >
                  <Check className="w-4 h-4" />
                </Button>
              </div>
            </motion.div>
          ))}
        </div>
      </motion.div>
    </div>
  );
};

export default AIInsights;
