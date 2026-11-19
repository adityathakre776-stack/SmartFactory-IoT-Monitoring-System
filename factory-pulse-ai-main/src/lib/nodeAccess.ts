export const NODE_IDS = ["NODE_01", "NODE_02", "NODE_03"] as const;

export type NodeId = (typeof NODE_IDS)[number];

export function normalizeNodeId(input?: string | null): NodeId | null {
  const val = String(input || "").trim().toUpperCase();
  if ((NODE_IDS as readonly string[]).includes(val)) {
    return val as NodeId;
  }
  return null;
}

export function inferAssignedNode(email?: string | null, fullName?: string | null): NodeId | null {
  const text = `${email || ""} ${fullName || ""}`.toLowerCase();
  const patterns = [/worker[\s_-]*([1-3])/, /node[\s_-]*0?([1-3])/, /\b([1-3])\b/];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return `NODE_0${match[1]}` as NodeId;
    }
  }
  return null;
}
