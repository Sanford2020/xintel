import type { TweetRecord } from "../types/index.js";
import { normalizeForHash } from "./normalize.js";

export interface DedupeOptions {
  minTextLength: number;
  shingleSize: number;
  similarityThreshold: number;
}

export interface DedupeStat {
  raw: number;
  deduped: number;
  duplicationRate: number;
  duplicates: { key: string; count: number; sample: string }[];
}

function shingles(text: string, k: number): Set<string> {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return new Set();
  const out = new Set<string>();
  if (tokens.length <= k) {
    out.add(tokens.join(" "));
    return out;
  }
  for (let i = 0; i <= tokens.length - k; i++) {
    out.add(tokens.slice(i, i + k).join(" "));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function dedupe(
  tweets: TweetRecord[],
  options: DedupeOptions,
): { unique: TweetRecord[]; stat: DedupeStat } {
  const sorted = [...tweets].sort((a, b) => {
    const ai = a.id ? parseInt(a.id, 10) : 0;
    const bi = b.id ? parseInt(b.id, 10) : 0;
    if (ai && bi) return bi - ai;
    return (b.capturedAt ?? "").localeCompare(a.capturedAt ?? "");
  });

  const unique: TweetRecord[] = [];
  const fingerprints: { key: string; shingles: Set<string>; sample: string; count: number }[] = [];
  const duplicates: Map<string, { count: number; sample: string }> = new Map();

  for (const tw of sorted) {
    const normForHash = normalizeForHash(tw.textNorm ?? tw.textRaw ?? "");
    if (normForHash.length < options.minTextLength) {
      // very short tweets: only dedupe on id+handle exact match
      const k = `${tw.id ?? ""}|${tw.handle ?? ""}|${normForHash}`;
      const dupOf = unique.find((u) => {
        const k2 = `${u.id ?? ""}|${u.handle ?? ""}|${normalizeForHash(u.textNorm ?? "")}`;
        return k && k === k2;
      });
      if (dupOf) {
        const cur = duplicates.get(k) ?? { count: 0, sample: normForHash };
        cur.count += 1;
        duplicates.set(k, cur);
        continue;
      }
      unique.push(tw);
      continue;
    }

    if (tw.id) {
      const dupOf = unique.find((u) => u.id === tw.id);
      if (dupOf) {
        const cur = duplicates.get(`id:${tw.id}`) ?? { count: 0, sample: normForHash };
        cur.count += 1;
        duplicates.set(`id:${tw.id}`, cur);
        continue;
      }
    }

    const sh = shingles(normForHash, options.shingleSize);
    let foundDup = false;
    for (const fp of fingerprints) {
      const sim = jaccard(sh, fp.shingles);
      if (sim >= options.similarityThreshold) {
        fp.count += 1;
        const cur = duplicates.get(fp.key) ?? { count: 0, sample: fp.sample };
        cur.count += 1;
        duplicates.set(fp.key, cur);
        foundDup = true;
        break;
      }
    }
    if (!foundDup) {
      const key = `${tw.handle ?? ""}|${normForHash.slice(0, 80)}`;
      fingerprints.push({ key, shingles: sh, sample: normForHash.slice(0, 200), count: 1 });
      unique.push(tw);
    }
  }

  const raw = tweets.length;
  const dedupedCount = unique.length;
  const rate = raw === 0 ? 0 : (raw - dedupedCount) / raw;

  return {
    unique,
    stat: {
      raw,
      deduped: dedupedCount,
      duplicationRate: Number(rate.toFixed(4)),
      duplicates: Array.from(duplicates.entries()).map(([key, v]) => ({
        key,
        count: v.count,
        sample: v.sample,
      })),
    },
  };
}
