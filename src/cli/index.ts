#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/index.js";
import { createLogger } from "../utils/logger.js";
import { parseDuration } from "../utils/time.js";
import {
  launchBrowser,
  type LaunchOptions,
} from "../browser/launchBrowser.js";
import { checkBrowserStatus } from "../browser/connectBrowser.js";
import { runCollect } from "./runner.js";
import { sendIpc } from "./ipc.js";
import { StatusStore } from "../storage/statusStore.js";
import { readJsonl } from "../storage/jsonlStore.js";
import type { RoundRecord } from "../types/index.js";
import { summarize } from "../analysis/summarize.js";
import { pushSummary } from "../integrations/notion.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readPkgVersion(): string {
  try {
    const p = resolve(__dirname, "..", "..", "package.json");
    const j = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
    return j.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();
program
  .name("xintel")
  .description("Local-only X.com intelligence collector with Notion ingestion (read-only)")
  .version(readPkgVersion())
  .option("--config <path>", "path to local config json", undefined);

const browser = program
  .command("browser")
  .description("Browser lifecycle commands");

browser
  .command("launch")
  .description("Launch Chrome/Edge with remote debugging on a dedicated profile")
  .option("--chrome-path <path>", "explicit browser binary path")
  .option("--port <port>", "remote debugging port", (v) => Number(v))
  .option("--user-data-dir <dir>", "profile directory")
  .option("--edge", "prefer Microsoft Edge")
  .option("--headless", "launch headless (not recommended for X)")
  .action(async (cmdOpts: LaunchOptions & { headless?: boolean }) => {
    const { config } = loadConfig({ configPath: program.opts<{ config?: string }>().config });
    const log = createLogger({
      level: config.logging.level,
      prettyPrint: config.logging.prettyPrint,
    });
    const b = await launchBrowser(
      {
        chromePath: cmdOpts.chromePath,
        port: cmdOpts.port,
        userDataDir: cmdOpts.userDataDir,
        edge: cmdOpts.edge,
        headless: cmdOpts.headless,
      },
      config,
    );
    log.info(
      { pid: b.pid, port: b.port, endpoint: b.endpoint, userDataDir: b.userDataDir },
      "Browser launched. Sign in to X.com in the opened window before running 'xintel collect'.",
    );
    console.log(JSON.stringify({
      pid: b.pid,
      port: b.port,
      endpoint: b.endpoint,
      userDataDir: b.userDataDir,
    }, null, 2));
  });

browser
  .command("status")
  .description("Check if the remote debugging port is reachable")
  .option("--port <port>", "remote debugging port", (v) => Number(v))
  .option("--json", "machine-readable output")
  .action(async (cmdOpts: { port?: number; json?: boolean }) => {
    const { config } = loadConfig({ configPath: program.opts<{ config?: string }>().config });
    const port = cmdOpts.port ?? config.browser.port;
    const status = await checkBrowserStatus(port, config.browser.healthCheckTimeoutMs);
    if (cmdOpts.json) {
      console.log(JSON.stringify(status, null, 2));
    } else if (status.reachable) {
      console.log(`Browser reachable on port ${port}: ${status.browserVersion ?? "?"}`);
    } else {
      console.log(`Browser NOT reachable on port ${port}: ${status.error ?? "unknown"}`);
      process.exitCode = 1;
    }
  });

program
  .command("collect")
  .description("Run multi-round read-only collection")
  .option("-r, --rounds <n>", "number of rounds", (v) => Number(v))
  .option("-i, --interval <dur>", "interval between rounds (e.g. 30s, 2m)")
  .option("--port <port>", "browser debug port", (v) => Number(v))
  .option("--sources <list>", "comma-separated subset of page types to collect (for_you,following,explore,trends,list,search)")
  .option("--out <file>", "output JSONL file (defaults to data/runs/<runId>.jsonl)")
  .action(async (cmdOpts: {
    rounds?: number;
    interval?: string;
    port?: number;
    sources?: string;
    out?: string;
  }) => {
    const { config, hash } = loadConfig({
      configPath: program.opts<{ config?: string }>().config,
    });
    const rounds = cmdOpts.rounds ?? config.schedule.rounds;
    const intervalMs = cmdOpts.interval
      ? parseDuration(cmdOpts.interval)
      : config.schedule.intervalMs;
    const port = cmdOpts.port ?? config.browser.port;
    const sources = cmdOpts.sources
      ? cmdOpts.sources.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    await runCollect(config, {
      rounds,
      intervalMs,
      port,
      sources,
      configHash: hash,
      appVersion: readPkgVersion(),
      outputFile: cmdOpts.out,
    });
  });

program
  .command("pause")
  .description("Pause a running collection")
  .action(async () => {
    const { config } = loadConfig({ configPath: program.opts<{ config?: string }>().config });
    const resp = await sendIpc(config.paths.ipcSocket, { cmd: "pause" });
    console.log(JSON.stringify(resp, null, 2));
  });

program
  .command("resume")
  .description("Resume a paused collection")
  .action(async () => {
    const { config } = loadConfig({ configPath: program.opts<{ config?: string }>().config });
    const resp = await sendIpc(config.paths.ipcSocket, { cmd: "resume" });
    console.log(JSON.stringify(resp, null, 2));
  });

program
  .command("stop")
  .description("Stop a running collection")
  .action(async () => {
    const { config } = loadConfig({ configPath: program.opts<{ config?: string }>().config });
    const resp = await sendIpc(config.paths.ipcSocket, { cmd: "stop" });
    console.log(JSON.stringify(resp, null, 2));
  });

program
  .command("status")
  .description("Show current collection status")
  .option("--json", "machine-readable output")
  .action(async (cmdOpts: { json?: boolean }) => {
    const { config } = loadConfig({ configPath: program.opts<{ config?: string }>().config });
    let live = null;
    try {
      live = await sendIpc(config.paths.ipcSocket, { cmd: "status" }, 1000);
    } catch {
      // not running
    }
    const stored = StatusStore.load(config.paths.statusFile);
    const out = { live, stored };
    if (cmdOpts.json) {
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    if (live?.ok) {
      console.log("running:", JSON.stringify(live.data, null, 2));
    } else if (stored) {
      console.log(`no live process; last state: ${stored.state}`);
      console.log(JSON.stringify(stored, null, 2));
    } else {
      console.log("no status available (collector has not been run yet)");
    }
  });

program
  .command("summarize")
  .description("Generate Markdown briefing from a collected JSONL file")
  .requiredOption("--input <file>", "path to data/runs/<runId>.jsonl")
  .option("--out <file>", "output Markdown path (default: data/summaries/<runId>.md)")
  .option("--json", "also write summary.json next to the markdown")
  .action(async (cmdOpts: { input: string; out?: string; json?: boolean }) => {
    const { config } = loadConfig({ configPath: program.opts<{ config?: string }>().config });
    const input = resolve(cmdOpts.input);
    if (!existsSync(input)) {
      throw new Error(`Input JSONL not found: ${input}`);
    }
    const rounds = await readJsonl<RoundRecord>(input);
    if (rounds.length === 0) {
      throw new Error(`No rounds parsed from ${input}`);
    }
    const runId = rounds[0]?.meta?.configHash
      ? `${rounds[0]!.startedAt.slice(0, 10)}-${rounds[0]!.meta.configHash}`
      : "run";
    const { summary, markdown } = summarize({ runId, rounds, config });
    const defaultOut = resolve(
      config.paths.summariesDir,
      `${runId}.md`,
    );
    const outPath = cmdOpts.out ? resolve(cmdOpts.out) : defaultOut;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, markdown, "utf8");
    if (cmdOpts.json) {
      const jsonOut = outPath.replace(/\.md$/, ".json");
      writeFileSync(jsonOut, JSON.stringify(summary, null, 2), "utf8");
    }
    console.log(outPath);
  });

const notion = program.command("notion").description("Notion ingestion commands");
notion
  .command("push")
  .description("Push a Markdown briefing to a Notion parent page")
  .requiredOption("--summary <file>", "Markdown summary file produced by 'xintel summarize'")
  .option("--parent-page-id <id>", "Notion parent page id (overrides config)")
  .option("--token <token>", "Notion internal integration token (defaults to env NOTION_TOKEN)")
  .option("--title <title>", "override page title")
  .action(async (cmdOpts: { summary: string; parentPageId?: string; token?: string; title?: string }) => {
    const { config } = loadConfig({ configPath: program.opts<{ config?: string }>().config });
    if (!cmdOpts.parentPageId && !config.notion.parentPageId && !process.env.NOTION_PARENT_PAGE_ID) {
      console.error(
        "Notion parent page id is not configured. Pass --parent-page-id, " +
          "or set notion.parentPageId in config/local.json, or NOTION_PARENT_PAGE_ID env var.",
      );
      process.exitCode = 2;
      return;
    }
    const result = await pushSummary(
      {
        summaryPath: resolve(cmdOpts.summary),
        parentPageId: cmdOpts.parentPageId ?? null,
        notionToken: cmdOpts.token,
        titleOverride: cmdOpts.title,
      },
      config,
    );
    console.log(JSON.stringify(result, null, 2));
  });

const conf = program.command("config").description("Configuration helpers");
conf
  .command("show")
  .description("Print the merged configuration (after defaults + local overrides)")
  .action(() => {
    const { config, sources, hash } = loadConfig({
      configPath: program.opts<{ config?: string }>().config,
    });
    console.log(JSON.stringify({ hash, sources, config }, null, 2));
  });

conf
  .command("init")
  .description("Create config/local.json from the example template if missing")
  .action(() => {
    const projectRoot = resolve(__dirname, "..", "..");
    const target = resolve(projectRoot, "config", "local.json");
    if (existsSync(target)) {
      console.log(`config/local.json already exists at ${target}`);
      return;
    }
    const src = resolve(projectRoot, "config", "local.example.json");
    if (!existsSync(src)) {
      throw new Error(`Missing template ${src}`);
    }
    writeFileSync(target, readFileSync(src, "utf8"), "utf8");
    console.log(`wrote ${target}`);
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const e = err as Error;
    console.error(`xintel: ${e.message}`);
    process.exit(1);
  }
}

void main();
