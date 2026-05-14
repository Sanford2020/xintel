import { resolve } from "node:path";
import { connectBrowser, checkBrowserStatus } from "../browser/connectBrowser.js";
import {
  buildTargets,
  collectOnce,
  type CollectTarget,
} from "../collectors/xCollector.js";
import { JsonlStore } from "../storage/jsonlStore.js";
import { StatusStore } from "../storage/statusStore.js";
import {
  acquireSingleInstanceLock,
  type ReleaseLock,
} from "../storage/lock.js";
import { IpcServer, type IpcResponse } from "./ipc.js";
import { ensureDir, rid } from "../utils/paths.js";
import { nowIso, sleep } from "../utils/time.js";
import { createLogger, getLogger } from "../utils/logger.js";
import type { AppConfig } from "../config/schema.js";
import type {
  PageRecord,
  RoundRecord,
  RunStatus,
} from "../types/index.js";

export interface RunOptions {
  rounds: number;
  intervalMs: number;
  port: number;
  sources?: string[];
  configHash: string;
  appVersion: string;
  outputFile?: string;
}

interface RunnerSignals {
  abort: AbortController;
  pause: { value: boolean };
  stop: { value: boolean };
}

export async function runCollect(
  cfg: AppConfig,
  opts: RunOptions,
): Promise<void> {
  ensureDir(cfg.paths.runsDir);
  ensureDir(cfg.paths.logsDir);

  const log = createLogger({
    level: cfg.logging.level,
    prettyPrint: cfg.logging.prettyPrint,
    logFile: resolve(cfg.paths.logsDir, "collector.log"),
    errFile: resolve(cfg.paths.logsDir, "collector.err.log"),
  });

  const runId = rid("run");
  const out = opts.outputFile ?? resolve(cfg.paths.runsDir, `${runId}.jsonl`);
  log.info({ runId, out, rounds: opts.rounds, intervalMs: opts.intervalMs }, "Starting collection");

  let release: ReleaseLock | null = null;
  try {
    release = await acquireSingleInstanceLock(cfg.paths.lockFile);
  } catch (err) {
    log.error({ err: (err as Error).message }, "Could not acquire lock");
    throw err;
  }

  const jsonl = new JsonlStore(out);
  const initialStatus: RunStatus = {
    pid: process.pid,
    state: "running",
    startedAt: nowIso(),
    updatedAt: nowIso(),
    currentRound: 0,
    totalRounds: opts.rounds,
    currentOutputFile: out,
    runId,
    browser: { connected: false },
  };
  const status = new StatusStore(cfg.paths.statusFile, initialStatus);

  const signals: RunnerSignals = {
    abort: new AbortController(),
    pause: { value: false },
    stop: { value: false },
  };

  const ipc = new IpcServer(cfg.paths.ipcSocket, {
    onPause: (): IpcResponse => {
      signals.pause.value = true;
      status.update({ state: "paused" });
      return { ok: true, data: { state: "paused" } };
    },
    onResume: (): IpcResponse => {
      signals.pause.value = false;
      status.update({ state: "running" });
      return { ok: true, data: { state: "running" } };
    },
    onStop: (): IpcResponse => {
      signals.stop.value = true;
      status.update({ state: "stopping" });
      signals.abort.abort();
      return { ok: true, data: { state: "stopping" } };
    },
    onStatus: (): IpcResponse => ({ ok: true, data: status.get() }),
  });
  await ipc.start();

  const onSignal = (sig: NodeJS.Signals) => {
    log.warn({ sig }, "Received signal, stopping...");
    signals.stop.value = true;
    status.update({ state: "stopping" });
    signals.abort.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let allTargets = buildTargets(cfg);
  if (opts.sources && opts.sources.length > 0) {
    const set = new Set(opts.sources.map((s) => s.trim().toLowerCase()));
    allTargets = allTargets.filter((t) => set.has(t.type));
  }
  if (allTargets.length === 0) {
    throw new Error("No collection targets enabled in configuration.");
  }

  // Connect browser
  status.update({ browser: { connected: false, endpoint: undefined } });
  const stat = await checkBrowserStatus(opts.port, cfg.browser.healthCheckTimeoutMs);
  if (!stat.reachable) {
    status.update({
      state: "error",
      lastError: `browser not reachable: ${stat.error ?? "unknown"}`,
      lastErrorAt: nowIso(),
    });
    throw new Error(
      `Browser debug port ${opts.port} unreachable. Run 'xintel browser launch' first or open Chrome with --remote-debugging-port=${opts.port}.`,
    );
  }

  let connection;
  try {
    connection = await connectBrowser(opts.port);
  } catch (err) {
    status.update({
      state: "error",
      lastError: (err as Error).message,
      lastErrorAt: nowIso(),
    });
    throw err;
  }
  status.update({
    browser: { connected: true, endpoint: connection.endpoint, lastPingAt: nowIso() },
  });

  let consecutiveFailures = 0;

  try {
    for (let round = 1; round <= opts.rounds; round++) {
      if (signals.stop.value) break;
      while (signals.pause.value && !signals.stop.value) {
        await sleep(1000).catch(() => undefined);
      }
      if (signals.stop.value) break;

      status.update({ currentRound: round, state: "running" });
      log.info({ round, total: opts.rounds }, "round start");

      // re-check connection health before each round
      const healthy = await checkBrowserStatus(opts.port, cfg.browser.healthCheckTimeoutMs);
      if (!healthy.reachable) {
        log.error({ port: opts.port, err: healthy.error }, "browser unreachable, attempting reconnect");
        try {
          await connection.close();
        } catch { /* ignore */ }
        try {
          connection = await connectBrowser(opts.port);
          status.update({
            browser: { connected: true, endpoint: connection.endpoint, lastPingAt: nowIso() },
          });
        } catch (err) {
          consecutiveFailures += 1;
          status.update({
            state: "error",
            lastError: `browser reconnect failed: ${(err as Error).message}`,
            lastErrorAt: nowIso(),
            browser: { connected: false },
          });
          if (consecutiveFailures >= cfg.schedule.maxConsecutiveFailures) {
            log.error("too many consecutive failures, aborting");
            break;
          }
          await sleep(Math.max(5000, opts.intervalMs / 2)).catch(() => undefined);
          continue;
        }
      }

      const roundStart = Date.now();
      const startedAt = nowIso();
      let pages: PageRecord[];
      try {
        pages = await collectOnce(
          connection.context,
          cfg,
          allTargets as CollectTarget[],
          { round, signal: signals.abort.signal },
        );
      } catch (err) {
        consecutiveFailures += 1;
        log.error({ err: (err as Error).message, round }, "round failed");
        status.update({
          state: "error",
          lastError: (err as Error).message,
          lastErrorAt: nowIso(),
        });
        if (consecutiveFailures >= cfg.schedule.maxConsecutiveFailures) {
          break;
        }
        await sleep(opts.intervalMs).catch(() => undefined);
        continue;
      }

      const failed = pages.filter((p) => p.error).length;
      if (failed === pages.length && pages.length > 0) {
        consecutiveFailures += 1;
      } else {
        consecutiveFailures = 0;
      }

      const record: RoundRecord = {
        round,
        startedAt,
        finishedAt: nowIso(),
        durationMs: Date.now() - roundStart,
        pages,
        meta: {
          appVersion: opts.appVersion,
          configHash: opts.configHash,
          browserEndpoint: connection.endpoint,
        },
      };
      await jsonl.appendRound(record);
      status.update({
        currentRound: round,
        lastSuccessAt: failed === pages.length ? status.get().lastSuccessAt : nowIso(),
        lastError: failed > 0 ? `${failed}/${pages.length} pages failed` : undefined,
        lastErrorAt: failed > 0 ? nowIso() : status.get().lastErrorAt,
      });

      if (round < opts.rounds && !signals.stop.value) {
        try {
          await sleep(opts.intervalMs, signals.abort.signal);
        } catch {
          // aborted
          break;
        }
      }
    }
  } finally {
    status.update({ state: "stopped" });
    try { await ipc.stop(); } catch { /* ignore */ }
    try { await connection.close(); } catch { /* ignore */ }
    try { await jsonl.close(); } catch { /* ignore */ }
    if (release) await release();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    getLogger().info({ runId, out }, "Collection finished");
  }
}
