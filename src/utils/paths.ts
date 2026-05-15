import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export function ensureDir(path: string): string {
  const abs = resolve(path);
  mkdirSync(abs, { recursive: true });
  return abs;
}

export function rid(prefix = "run"): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${prefix}-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}
