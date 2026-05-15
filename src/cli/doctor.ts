import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkBrowserStatus } from "../browser/connectBrowser.js";
import { StatusStore } from "../storage/statusStore.js";
import type { AppConfig } from "../config/schema.js";
import type { LoadedPack } from "../config/packs.js";
import type { RoundRecord } from "../types/index.js";

export type DoctorCheckStatus = "ok" | "warn" | "fail" | "info";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail: string;
  recommendation?: string;
}

export interface DoctorReport {
  generatedAt: string;
  overall: DoctorCheckStatus;
  checks: DoctorCheck[];
}

function worse(a: DoctorCheckStatus, b: DoctorCheckStatus): DoctorCheckStatus {
  const order: DoctorCheckStatus[] = ["ok", "info", "warn", "fail"];
  return order.indexOf(b) > order.indexOf(a) ? b : a;
}

async function checkBrowser(cfg: AppConfig): Promise<DoctorCheck> {
  const stat = await checkBrowserStatus(cfg.browser.port, cfg.browser.healthCheckTimeoutMs);
  if (stat.reachable) {
    return {
      id: "browser",
      label: "Browser debug port",
      status: "ok",
      detail: `reachable on :${cfg.browser.port} (${stat.browserVersion ?? "unknown version"})`,
    };
  }
  return {
    id: "browser",
    label: "Browser debug port",
    status: "warn",
    detail: `port :${cfg.browser.port} not reachable: ${stat.error ?? "unknown"}`,
    recommendation: `Run 'xintel browser launch' or start Chrome with --remote-debugging-port=${cfg.browser.port}.`,
  };
}

function checkStatusFile(cfg: AppConfig): DoctorCheck {
  const st = StatusStore.load(cfg.paths.statusFile);
  if (!st) {
    return {
      id: "status",
      label: "Last run status",
      status: "info",
      detail: "no run recorded yet — collector has never been started",
    };
  }
  const ageMs = Date.now() - new Date(st.updatedAt).getTime();
  const ageMin = Math.round(ageMs / 60_000);
  if (st.state === "error") {
    return {
      id: "status",
      label: "Last run status",
      status: "fail",
      detail: `last state=error (${ageMin}m ago): ${st.lastError ?? "(no message)"}`,
      recommendation: "Run 'xintel collect' again; if same error persists, check browser login state.",
    };
  }
  if (st.state === "stopped" || st.state === "idle") {
    return {
      id: "status",
      label: "Last run status",
      status: "info",
      detail: `state=${st.state}, last update ${ageMin}m ago, runId=${st.runId}`,
    };
  }
  return {
    id: "status",
    label: "Last run status",
    status: "ok",
    detail: `state=${st.state}, currentRound=${st.currentRound}/${st.totalRounds}`,
  };
}

function checkSelectorDrift(cfg: AppConfig): DoctorCheck {
  if (!existsSync(cfg.paths.runsDir)) {
    return {
      id: "selector-drift",
      label: "Selector drift / collection yield",
      status: "info",
      detail: "no runs directory yet",
    };
  }
  const files = readdirSync(cfg.paths.runsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, p: join(cfg.paths.runsDir, f) }))
    .map(({ f, p }) => ({ f, p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3);
  if (files.length === 0) {
    return {
      id: "selector-drift",
      label: "Selector drift / collection yield",
      status: "info",
      detail: "no run files yet",
    };
  }
  let totalRounds = 0;
  let zeroTweetPages = 0;
  let totalPages = 0;
  for (const { p } of files) {
    try {
      const raw = readFileSync(p, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as RoundRecord;
        totalRounds += 1;
        for (const pg of r.pages) {
          totalPages += 1;
          if (pg.tweets.length === 0 && pg.type !== "trends") zeroTweetPages += 1;
        }
      }
    } catch {
      // skip malformed file
    }
  }
  if (totalPages === 0) {
    return {
      id: "selector-drift",
      label: "Selector drift / collection yield",
      status: "info",
      detail: "no parseable round records yet",
    };
  }
  const zeroPct = (100 * zeroTweetPages) / totalPages;
  if (zeroPct >= 80) {
    return {
      id: "selector-drift",
      label: "Selector drift / collection yield",
      status: "fail",
      detail: `${zeroPct.toFixed(0)}% of recent feed pages returned 0 tweets across ${totalRounds} round(s)`,
      recommendation:
        "Likely causes (in order): (1) you are not logged into X in the launched browser, (2) X has changed DOM selectors and src/collectors/extract.ts needs updating, (3) network/rate-limit. Open the launched Chrome window and confirm the feed shows tweets.",
    };
  }
  if (zeroPct >= 40) {
    return {
      id: "selector-drift",
      label: "Selector drift / collection yield",
      status: "warn",
      detail: `${zeroPct.toFixed(0)}% of recent feed pages returned 0 tweets`,
      recommendation: "Inspect a recent JSONL file. If most pages have 0 tweets, suspect login wall or selector drift.",
    };
  }
  return {
    id: "selector-drift",
    label: "Selector drift / collection yield",
    status: "ok",
    detail: `${zeroPct.toFixed(0)}% empty pages across ${totalRounds} round(s) — healthy`,
  };
}

function checkPacks(packs: LoadedPack[], missing: string[]): DoctorCheck {
  if (missing.length > 0) {
    return {
      id: "packs",
      label: "Segment packs",
      status: "fail",
      detail: `missing packs: ${missing.join(", ")}`,
      recommendation: "Run 'xintel pack list' to see available packs; add JSON to config/packs/.",
    };
  }
  if (packs.length === 0) {
    return {
      id: "packs",
      label: "Segment packs",
      status: "info",
      detail: "no packs enabled — using built-in classify.topics",
      recommendation:
        "Set packs.enabled in config/local.json to enable a customer-specific pack (e.g. ai-watcher).",
    };
  }
  const summary = packs
    .map((p) => `${p.pack.name}(${Object.keys(p.pack.topics).length} topics)`)
    .join(", ");
  return {
    id: "packs",
    label: "Segment packs",
    status: "ok",
    detail: `${packs.length} pack(s) loaded: ${summary}`,
  };
}

function checkLlm(cfg: AppConfig): DoctorCheck {
  if (!cfg.llm.enabled) {
    return {
      id: "llm",
      label: "LLM integration",
      status: "info",
      detail: "disabled (rule-based mode only)",
      recommendation:
        "Set llm.enabled=true and llm.provider=anthropic|openai|google in config/local.json to get LLM-enhanced briefings.",
    };
  }
  const envName = cfg.llm.apiKeyEnv || defaultEnvFor(cfg.llm.provider);
  const present = !!process.env[envName];
  if (!present) {
    return {
      id: "llm",
      label: "LLM integration",
      status: "warn",
      detail: `enabled provider=${cfg.llm.provider}, but env var ${envName} is not set`,
      recommendation: `Export ${envName}=... before running 'xintel summarize'. Without it, briefing falls back to rule-based mode.`,
    };
  }
  return {
    id: "llm",
    label: "LLM integration",
    status: "ok",
    detail: `provider=${cfg.llm.provider} model=${cfg.llm.model || "(default)"}`,
  };
}

function checkPush(cfg: AppConfig): DoctorCheck {
  const channels = cfg.push.channels;
  if (channels.length === 0) {
    return {
      id: "push",
      label: "Push channels",
      status: "info",
      detail: "no push channels configured",
      recommendation:
        "Add entries under push.channels (notion / webhook / slack / discord / telegram) in config/local.json.",
    };
  }
  const enabled = channels.filter((c) => c.enabled);
  if (enabled.length === 0) {
    return {
      id: "push",
      label: "Push channels",
      status: "warn",
      detail: `${channels.length} channel(s) defined but none enabled`,
    };
  }
  return {
    id: "push",
    label: "Push channels",
    status: "ok",
    detail: enabled.map((c) => `${c.type}:${c.name || "(unnamed)"}`).join(", "),
  };
}

function defaultEnvFor(provider: string): string {
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_API_KEY";
    default:
      return "";
  }
}

export async function runDoctor(
  cfg: AppConfig,
  packs: LoadedPack[],
  missingPacks: string[],
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(await checkBrowser(cfg));
  checks.push(checkStatusFile(cfg));
  checks.push(checkSelectorDrift(cfg));
  checks.push(checkPacks(packs, missingPacks));
  checks.push(checkLlm(cfg));
  checks.push(checkPush(cfg));

  let overall: DoctorCheckStatus = "ok";
  for (const c of checks) overall = worse(overall, c.status);

  return {
    generatedAt: new Date().toISOString(),
    overall,
    checks,
  };
}

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  const sym = (s: DoctorCheckStatus) =>
    s === "ok" ? "[OK]  " : s === "info" ? "[INFO]" : s === "warn" ? "[WARN]" : "[FAIL]";
  lines.push(`xintel doctor  generatedAt=${report.generatedAt}  overall=${report.overall.toUpperCase()}`);
  lines.push("");
  for (const c of report.checks) {
    lines.push(`${sym(c.status)} ${c.label}`);
    lines.push(`        ${c.detail}`);
    if (c.recommendation) lines.push(`        → ${c.recommendation}`);
  }
  return lines.join("\n");
}
