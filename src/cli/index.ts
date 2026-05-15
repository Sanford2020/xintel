#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/index.js";
import { discoverPacks } from "../config/packs.js";
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
import { pushToChannels } from "../integrations/push.js";
import { buildLlmAdapter } from "../integrations/llm.js";
import {
  buildAggregate,
  compareDays,
  findPreviousAggregate,
  nowDate,
  writeAggregate,
} from "../storage/dayAggregates.js";
import { runDoctor, formatReport } from "./doctor.js";
import { startServer } from "./serve.js";

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
  .description("Local-only X.com intelligence platform with Segment Packs (read-only)")
  .version(readPkgVersion())
  .option("--config <path>", "path to local config json", undefined)
  .option("--pack <name>", "override enabled segment packs for this command (comma-separated)");

interface RootOpts {
  config?: string;
  pack?: string;
}

function rootOpts(): { configPath?: string; packs?: string[] } {
  const o = program.opts<RootOpts>();
  return {
    configPath: o.config,
    packs: o.pack ? o.pack.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
  };
}

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
    const { config } = loadConfig(rootOpts());
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
    const { config } = loadConfig(rootOpts());
    const port = cmdOpts.port ?? config.browser.port;
    const status = await checkBrowserStatus(port, config.browser.healthCheckTimeoutMs);
    if (cmdOpts.json) {
      console.log(JSON.stringify(status, null, 2));
    } else if (status.reachable) {
      console.log(`Browser reachable on port ${port}: ${status.browserVersion ?? "?"}`);
    } else {
      console.log(`Browser NOT reachable on port ${port}: ${status.error ?? "unknown"}`);
    }
    // T3 fix: exit code must be set regardless of --json
    if (!status.reachable) process.exitCode = 1;
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
    const { config, hash } = loadConfig(rootOpts());
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
    const { config } = loadConfig(rootOpts());
    const resp = await sendIpc(config.paths.ipcSocket, { cmd: "pause" });
    console.log(JSON.stringify(resp, null, 2));
  });

program
  .command("resume")
  .description("Resume a paused collection")
  .action(async () => {
    const { config } = loadConfig(rootOpts());
    const resp = await sendIpc(config.paths.ipcSocket, { cmd: "resume" });
    console.log(JSON.stringify(resp, null, 2));
  });

program
  .command("stop")
  .description("Stop a running collection")
  .action(async () => {
    const { config } = loadConfig(rootOpts());
    const resp = await sendIpc(config.paths.ipcSocket, { cmd: "stop" });
    console.log(JSON.stringify(resp, null, 2));
  });

program
  .command("status")
  .description("Show current collection status")
  .option("--json", "machine-readable output")
  .action(async (cmdOpts: { json?: boolean }) => {
    const { config } = loadConfig(rootOpts());
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
  .description("Generate Markdown briefing from a collected JSONL file (with LLM + cross-day if enabled)")
  .requiredOption("--input <file>", "path to data/runs/<runId>.jsonl")
  .option("--out <file>", "output Markdown path (default: data/summaries/<runId>.md)")
  .option("--json", "also write summary.json next to the markdown")
  .option("--no-llm", "skip LLM enhancement even if enabled")
  .option("--no-aggregate", "skip writing the daily aggregate (no cross-day comparison)")
  .action(async (cmdOpts: { input: string; out?: string; json?: boolean; llm?: boolean; aggregate?: boolean }) => {
    const { config, packs } = loadConfig(rootOpts());
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

    const pack = packs[0]?.pack ?? null;
    const packName = pack?.name ?? "default";

    const llm = cmdOpts.llm === false ? null : buildLlmAdapter(config.llm);

    const date = nowDate();
    const previous = findPreviousAggregate(config.paths.aggregatesDir, date, packName);
    const partial = await summarize({ runId, rounds, config, pack, llm });
    const todayAgg = buildAggregate({
      pack: packName,
      date,
      raw: partial.aggregate.raw,
      deduped: partial.aggregate.deduped,
      perTopic: partial.aggregate.perTopic,
      perSource: partial.aggregate.perSource,
      highFrequency: partial.aggregate.highFrequency,
      rumorCount: partial.aggregate.rumorCount,
      noiseCount: partial.aggregate.noiseCount,
    });
    const comparison = compareDays(todayAgg, previous);

    // Re-render with comparison block now that we have it.
    const final = await summarize({ runId, rounds, config, pack, llm, comparison });

    const defaultOut = resolve(
      config.paths.summariesDir,
      `${date}-${packName}-${runId}.md`,
    );
    const outPath = cmdOpts.out ? resolve(cmdOpts.out) : defaultOut;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, final.markdown, "utf8");
    if (cmdOpts.json) {
      const jsonOut = outPath.replace(/\.md$/, ".json");
      writeFileSync(jsonOut, JSON.stringify(final.summary, null, 2), "utf8");
    }
    if (cmdOpts.aggregate !== false) {
      writeAggregate(config.paths.aggregatesDir, todayAgg);
    }
    console.log(outPath);
    if (final.llmUsed) {
      console.error(`(LLM enhancement applied; provider=${config.llm.provider})`);
    }
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
    const { config } = loadConfig(rootOpts());
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

program
  .command("push")
  .description("Push a briefing to all configured push channels (notion/webhook/slack/discord/telegram)")
  .requiredOption("--summary <file>", "Markdown briefing file path")
  .option("--title <title>", "override title")
  .option("--channels <list>", "comma-separated channel names or types (defaults: all enabled)")
  .action(async (cmdOpts: { summary: string; title?: string; channels?: string }) => {
    const { config } = loadConfig(rootOpts());
    const summaryPath = resolve(cmdOpts.summary);
    if (!existsSync(summaryPath)) {
      throw new Error(`Summary file not found: ${summaryPath}`);
    }
    const markdown = readFileSync(summaryPath, "utf8");
    const title = cmdOpts.title ?? `X 情报简报 - ${nowDate()}`;
    const channels = cmdOpts.channels
      ? cmdOpts.channels.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const outcome = await pushToChannels(
      { summaryPath, title, markdown, channels },
      config,
    );
    console.log(JSON.stringify(outcome, null, 2));
    if (outcome.failCount > 0 && outcome.okCount === 0) {
      process.exitCode = 1;
    }
  });

const pack = program.command("pack").description("Segment pack management");
pack
  .command("list")
  .description("List packs that are available in the configured search paths")
  .option("--json", "machine-readable output")
  .action((cmdOpts: { json?: boolean }) => {
    const { config, projectRoot, packs } = loadConfig(rootOpts());
    const available = discoverPacks(projectRoot, config.packs.searchPaths);
    const enabledNames = new Set(packs.map((p) => p.pack.name));
    if (cmdOpts.json) {
      console.log(
        JSON.stringify(
          available.map((p) => ({
            name: p.pack.name,
            description: p.pack.description,
            version: p.pack.version,
            audience: p.pack.audience,
            language: p.pack.language,
            topicCount: Object.keys(p.pack.topics).length,
            path: p.path,
            enabled: enabledNames.has(p.pack.name),
          })),
          null,
          2,
        ),
      );
      return;
    }
    if (available.length === 0) {
      console.log("No packs found. Add JSON to config/packs/ or another searchPaths entry.");
      return;
    }
    console.log(`Available packs (${available.length}):\n`);
    for (const p of available) {
      const mark = enabledNames.has(p.pack.name) ? "[x]" : "[ ]";
      console.log(`${mark} ${p.pack.name}  (${Object.keys(p.pack.topics).length} topics, ${p.pack.language})`);
      console.log(`    ${p.pack.description}`);
      console.log(`    audience: ${p.pack.audience}`);
      console.log(`    path: ${p.path}`);
      console.log("");
    }
    console.log(`Enable packs by setting packs.enabled in config/local.json, or via --pack <name> on any command.`);
  });

pack
  .command("show <name>")
  .description("Print the full JSON of a pack")
  .action((name: string) => {
    const { config, projectRoot } = loadConfig(rootOpts());
    const found = discoverPacks(projectRoot, config.packs.searchPaths).find((p) => p.pack.name === name);
    if (!found) {
      console.error(`Pack not found: ${name}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(found.pack, null, 2));
  });

program
  .command("doctor")
  .description("Run health checks (browser, last run, selector drift, packs, LLM, push)")
  .option("--json", "machine-readable output")
  .action(async (cmdOpts: { json?: boolean }) => {
    const { config, packs, missingPacks } = loadConfig(rootOpts());
    const report = await runDoctor(config, packs, missingPacks);
    if (cmdOpts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReport(report));
    }
    if (report.overall === "fail") process.exitCode = 1;
  });

program
  .command("serve")
  .description("Start the read-only web dashboard on localhost")
  .option("--port <port>", "TCP port to listen on", (v) => Number(v), 3478)
  .action(async (cmdOpts: { port: number }) => {
    const { config, packs } = loadConfig(rootOpts());
    const log = createLogger({
      level: config.logging.level,
      prettyPrint: config.logging.prettyPrint,
    });
    const server = startServer({ port: cmdOpts.port, cfg: config, packs });
    log.info({ url: server.url }, "Dashboard started");
    console.log(`xintel dashboard: ${server.url}`);
    console.log("Press Ctrl+C to stop.");
    const stop = async (sig: NodeJS.Signals) => {
      log.warn({ sig }, "Stopping dashboard");
      await server.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    // keep alive
    await new Promise(() => undefined);
  });

const conf = program.command("config").description("Configuration helpers");
conf
  .command("show")
  .description("Print the merged configuration (after defaults + local overrides + packs)")
  .action(() => {
    const { config, sources, hash, packs, missingPacks } = loadConfig(rootOpts());
    console.log(JSON.stringify({
      hash,
      sources,
      enabledPacks: packs.map((p) => p.pack.name),
      missingPacks,
      config,
    }, null, 2));
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
