import { readdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  SegmentPackSchema,
  type SegmentPack,
  type AppConfig,
} from "./schema.js";

export interface LoadedPack {
  pack: SegmentPack;
  /** Absolute filesystem path the pack was loaded from. */
  path: string;
}

export interface PackResolution {
  packs: LoadedPack[];
  missing: string[];
  searched: string[];
}

function readJson(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as unknown;
}

function listPackFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));
}

/**
 * Resolve enabled pack names against a list of search directories.
 *
 * The first matching `<name>.json` wins. Order of `searchPaths` defines
 * precedence (user overrides come first, then built-in).
 */
export function resolvePacks(
  projectRoot: string,
  enabled: string[],
  searchPaths: string[],
): PackResolution {
  const searched: string[] = [];
  const found: LoadedPack[] = [];
  const missing: string[] = [];

  const dirs = searchPaths.map((p) =>
    p.startsWith("/") ? p : resolve(projectRoot, p),
  );
  for (const d of dirs) searched.push(d);

  for (const name of enabled) {
    let hit: LoadedPack | null = null;
    for (const dir of dirs) {
      const candidate = join(dir, `${name}.json`);
      if (existsSync(candidate)) {
        const json = readJson(candidate);
        const parsed = SegmentPackSchema.parse(json);
        hit = { pack: parsed, path: candidate };
        break;
      }
    }
    if (hit) found.push(hit);
    else missing.push(name);
  }
  return { packs: found, missing, searched };
}

/** List all available packs in the configured search paths (for `xintel pack list`). */
export function discoverPacks(
  projectRoot: string,
  searchPaths: string[],
): LoadedPack[] {
  const dirs = searchPaths.map((p) =>
    p.startsWith("/") ? p : resolve(projectRoot, p),
  );
  const seen = new Set<string>();
  const out: LoadedPack[] = [];
  for (const dir of dirs) {
    for (const file of listPackFiles(dir)) {
      try {
        const json = readJson(file);
        const parsed = SegmentPackSchema.parse(json);
        if (seen.has(parsed.name)) continue;
        seen.add(parsed.name);
        out.push({ pack: parsed, path: file });
      } catch {
        // skip malformed packs; doctor will surface these
      }
    }
  }
  return out;
}

/**
 * Merge a list of resolved packs into the base AppConfig.
 *
 * Merge rules (intentionally additive, never destructive of user config):
 *  - `classify.topics`: pack topics added; existing keys are NOT overwritten.
 *  - `sources.search.queries`: pack queries appended (de-duped by `name`).
 *  - `sources.lists.items`: pack lists appended (de-duped by `name`).
 *
 * The base config is treated as the source of truth — user settings win.
 */
export function applyPacks(cfg: AppConfig, packs: LoadedPack[]): AppConfig {
  if (packs.length === 0) return cfg;
  const out: AppConfig = JSON.parse(JSON.stringify(cfg)) as AppConfig;

  for (const { pack } of packs) {
    for (const [key, def] of Object.entries(pack.topics)) {
      if (!out.classify.topics[key]) {
        out.classify.topics[key] = def;
      }
    }

    if (pack.searchQueries.length > 0) {
      const existingNames = new Set(
        out.sources.search.queries.map((q) => q.name),
      );
      for (const q of pack.searchQueries) {
        if (!existingNames.has(q.name)) {
          out.sources.search.queries.push(q);
          existingNames.add(q.name);
        }
      }
      if (!out.sources.search.enabled) out.sources.search.enabled = true;
    }

    if (pack.lists.length > 0) {
      const existingListNames = new Set(out.sources.lists.items.map((l) => l.name));
      for (const li of pack.lists) {
        if (!existingListNames.has(li.name)) {
          out.sources.lists.items.push(li);
          existingListNames.add(li.name);
        }
      }
      if (!out.sources.lists.enabled) out.sources.lists.enabled = true;
    }
  }
  return out;
}

/**
 * Pick a "primary" pack for report generation when multiple are enabled.
 *
 * Heuristic: take the first one. If none, returns null and the caller falls
 * back to the built-in (config/default.json) template.
 */
export function primaryPack(packs: LoadedPack[]): SegmentPack | null {
  return packs[0]?.pack ?? null;
}
