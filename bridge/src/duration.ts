const RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/;
const UNIT: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "30s" | "30m" | "2h" | "1d" | "500ms" into ms. A bare number is seconds. */
export function parseDuration(input: string): number {
  const m = RE.exec(String(input).trim());
  if (!m) throw new Error(`bad duration ${JSON.stringify(input)} — use 30s, 30m, 2h, 1d or 500ms`);
  const n = Number(m[1]);
  if (!Number.isFinite(n)) throw new Error(`bad duration ${JSON.stringify(input)}`);
  return Math.round(n * (UNIT[m[2] ?? "s"] as number));
}

/** Human form for the "you have N to answer" line on a question. */
export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}
