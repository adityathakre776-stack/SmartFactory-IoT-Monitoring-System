/**
 * Parse datetimes from the API. Backend should send ISO-8601 with offset (e.g. +05:30).
 * MySQL-style "YYYY-MM-DD HH:mm:ss" is normalized so JS does not treat it as UTC incorrectly.
 */
export function parseServerDateTime(value: unknown): Date {
  if (value == null || value === "") return new Date(NaN);
  if (value instanceof Date) return value;
  const s = String(value).trim();
  if (!s) return new Date(NaN);

  // Explicit Zulu or ±offset — trust the engine
  if (/Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s) || /[+-]\d{4}$/.test(s)) {
    return new Date(s);
  }

  // "YYYY-MM-DD HH:mm:ss" → ISO local-friendly form (space → T)
  const normalized = s.includes("T") ? s : s.replace(" ", "T");
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? new Date(s) : d;
}

/** Short time label for chart axes (browser local timezone). */
export function formatChartTime(value: unknown): string {
  const d = parseServerDateTime(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Date + time for lists / tooltips. */
export function formatServerDateTime(value: unknown): string {
  const d = parseServerDateTime(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
