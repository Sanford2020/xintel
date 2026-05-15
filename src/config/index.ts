import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ConfigSchema, type AppConfig } from "./schema.js";
import {
  resolvePacks,
  applyPacks,
  type LoadedPack,
} from "./packs.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const projectRoot = resolve(__dirname, "..", "..");

function readJsonIfExists(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(
      `Failed to parse config at ${path}: ${(err as Error).message}`,
    );
  }
}

function deepMerge<T>(target: T, source: unknown): T {
  if (source == null) return target;
  if (
    typeof target !== "object" ||
    typeof source !== "object" ||
    Array.isArray(target) ||
    Array.isArray(source) ||
    target === null
  ) {
    return source as T;
  }
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
    const cur = (target as Record<string, unknown>)[k];
    out[k] = deepMerge(cur as unknown, v);
  }
  return out as T;
}

export interface LoadConfigOptions {
  configPath?: string;
  /** Override pack names to enable, overriding config.packs.enabled. */
  packs?: string[];
}

export interface LoadedConfig {
  config: AppConfig;
  hash: string;
  sources: string[];
  projectRoot: string;
  packs: LoadedPack[];
  missingPacks: string[];
}

export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const defaultPath = resolve(projectRoot, "config", "default.json");
  const localPath = opts.configPath
    ? resolve(opts.configPath)
    : resolve(projectRoot, "config", "local.json");

  const defaults = readJsonIfExists(defaultPath);
  if (!defaults) {
    throw new Error(`Missing default config at ${defaultPath}`);
  }
  const sources = [defaultPath];

  let merged: unknown = defaults;
  const local = readJsonIfExists(localPath);
  if (local) {
    merged = deepMerge(merged, local);
    sources.push(localPath);
  }

  const parsed = ConfigSchema.parse(merged);

  parsed.paths.dataDir = resolve(projectRoot, parsed.paths.dataDir);
  parsed.paths.runsDir = resolve(projectRoot, parsed.paths.runsDir);
  parsed.paths.summariesDir = resolve(projectRoot, parsed.paths.summariesDir);
  parsed.paths.logsDir = resolve(projectRoot, parsed.paths.logsDir);
  parsed.paths.aggregatesDir = resolve(projectRoot, parsed.paths.aggregatesDir);
  parsed.paths.dashboardDir = resolve(projectRoot, parsed.paths.dashboardDir);
  parsed.paths.statusFile = resolve(projectRoot, parsed.paths.statusFile);
  parsed.paths.lockFile = resolve(projectRoot, parsed.paths.lockFile);
  parsed.paths.ipcSocket = resolve(projectRoot, parsed.paths.ipcSocket);

  if (!parsed.browser.userDataDir.startsWith("/")) {
    parsed.browser.userDataDir = resolve(projectRoot, parsed.browser.userDataDir);
  }

  const enabledPacks = opts.packs ?? parsed.packs.enabled;
  const packResolution = resolvePacks(
    projectRoot,
    enabledPacks,
    parsed.packs.searchPaths,
  );
  const withPacks = applyPacks(parsed, packResolution.packs);

  const hash = createHash("sha256")
    .update(JSON.stringify(withPacks))
    .digest("hex")
    .slice(0, 12);

  return {
    config: withPacks,
    hash,
    sources,
    projectRoot,
    packs: packResolution.packs,
    missingPacks: packResolution.missing,
  };
}

export function getProjectRoot(): string {
  return projectRoot;
}

export type { AppConfig } from "./schema.js";
