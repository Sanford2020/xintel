import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface DailyAggregate {
  date: string; // YYYY-MM-DD
  pack: string; // pack name or "default"
  raw: number;
  deduped: number;
  perTopic: Record<string, number>;
  perSource: Record<string, number>;
  highFrequency: { phrase: string; count: number }[];
  rumorCount: number;
  noiseCount: number;
  updatedAt: string;
}

export interface DayDelta {
  topic: string;
  todayCount: number;
  yesterdayCount: number;
  /** Multiplicative change (today / yesterday). Infinity if yesterday=0. */
  ratio: number;
  /** Absolute change (today - yesterday). */
  diff: number;
  /** Percent change (e.g. +120 means +120%). */
  pct: number;
}

export interface AggregateComparison {
  date: string;
  previousDate: string;
  todayTopicCounts: Record<string, number>;
  yesterdayTopicCounts: Record<string, number>;
  deltas: DayDelta[];
  /** Topics that appeared today but not yesterday (≥3 mentions). */
  newToday: string[];
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function pathFor(dir: string, date: string, pack: string): string {
  const safe = pack.replace(/[^a-z0-9_-]/gi, "_") || "default";
  return join(dir, `${date}-${safe}.json`);
}

/** Ensure aggregates dir exists; write the per-day aggregate. */
export function writeAggregate(
  aggregatesDir: string,
  agg: DailyAggregate,
): void {
  mkdirSync(aggregatesDir, { recursive: true });
  const path = pathFor(aggregatesDir, agg.date, agg.pack);
  writeFileSync(path, JSON.stringify(agg, null, 2), "utf8");
}

export function readAggregate(
  aggregatesDir: string,
  date: string,
  pack: string,
): DailyAggregate | null {
  const path = pathFor(aggregatesDir, date, pack);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DailyAggregate;
  } catch {
    return null;
  }
}

/** Find the most recent aggregate file for `pack` strictly before `date`. */
export function findPreviousAggregate(
  aggregatesDir: string,
  date: string,
  pack: string,
): DailyAggregate | null {
  if (!existsSync(aggregatesDir)) return null;
  const safe = pack.replace(/[^a-z0-9_-]/gi, "_") || "default";
  const suffix = `-${safe}.json`;
  const candidates = readdirSync(aggregatesDir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => f.replace(suffix, ""))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => d < date)
    .sort();
  const prev = candidates.pop();
  if (!prev) return null;
  return readAggregate(aggregatesDir, prev, pack);
}

export function compareDays(
  today: DailyAggregate,
  previous: DailyAggregate | null,
): AggregateComparison {
  const todayCounts = today.perTopic;
  const yesterdayCounts = previous?.perTopic ?? {};

  const deltas: DayDelta[] = [];
  const allKeys = new Set([
    ...Object.keys(todayCounts),
    ...Object.keys(yesterdayCounts),
  ]);
  for (const k of allKeys) {
    const t = todayCounts[k] ?? 0;
    const y = yesterdayCounts[k] ?? 0;
    const diff = t - y;
    const ratio = y === 0 ? (t === 0 ? 1 : Infinity) : t / y;
    const pct = y === 0 ? (t === 0 ? 0 : 100 * t) : 100 * (t - y) / y;
    deltas.push({ topic: k, todayCount: t, yesterdayCount: y, ratio, diff, pct });
  }
  deltas.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  const newToday: string[] = [];
  for (const k of Object.keys(todayCounts)) {
    if ((yesterdayCounts[k] ?? 0) === 0 && (todayCounts[k] ?? 0) >= 3) {
      newToday.push(k);
    }
  }

  return {
    date: today.date,
    previousDate: previous?.date ?? "",
    todayTopicCounts: todayCounts,
    yesterdayTopicCounts: yesterdayCounts,
    deltas,
    newToday,
  };
}

export function nowDate(): string {
  return todayUtc();
}

/** Convenience helper: assemble today's aggregate from summarized stats. */
export function buildAggregate(args: {
  pack: string;
  date?: string;
  raw: number;
  deduped: number;
  perTopic: Record<string, number>;
  perSource: Record<string, number>;
  highFrequency: { phrase: string; count: number }[];
  rumorCount: number;
  noiseCount: number;
}): DailyAggregate {
  return {
    date: args.date ?? todayUtc(),
    pack: args.pack || "default",
    raw: args.raw,
    deduped: args.deduped,
    perTopic: args.perTopic,
    perSource: args.perSource,
    highFrequency: args.highFrequency.slice(0, 50),
    rumorCount: args.rumorCount,
    noiseCount: args.noiseCount,
    updatedAt: new Date().toISOString(),
  };
}

/** Resolve a relative path against `projectRoot` if not absolute. */
export function resolveAggregatesDir(projectRoot: string, p: string): string {
  return p.startsWith("/") ? p : resolve(projectRoot, p);
}
