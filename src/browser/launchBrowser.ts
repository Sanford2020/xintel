import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { ensureDir } from "../utils/paths.js";
import { getLogger } from "../utils/logger.js";
import type { AppConfig } from "../config/schema.js";

export interface LaunchOptions {
  chromePath?: string;
  port?: number;
  userDataDir?: string;
  edge?: boolean;
  extraArgs?: string[];
  headless?: boolean;
}

export interface LaunchedBrowser {
  pid: number;
  endpoint: string;
  port: number;
  userDataDir: string;
  child: ChildProcess;
}

function resolveBrowserPath(opts: LaunchOptions, cfg: AppConfig): string {
  if (opts.chromePath) return opts.chromePath;
  if (cfg.browser.chromePath) return cfg.browser.chromePath;

  const candidates: string[] = [];
  const wantEdge = opts.edge ?? cfg.browser.channel === "msedge";

  if (process.platform === "win32") {
    if (wantEdge) {
      candidates.push(
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      );
    } else {
      candidates.push(
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      wantEdge
        ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  } else {
    candidates.push(
      ...(wantEdge
        ? ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ]),
    );
  }

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Could not locate a Chrome/Edge binary on this system (${platform()}). ` +
      `Pass --chrome-path or set browser.chromePath in config.`,
  );
}

/**
 * Launch a Chrome/Edge process with remote debugging enabled, using a dedicated
 * profile directory. The launched process is detached from this CLI so that
 * `xintel collect` can connect to it later via CDP.
 *
 * Strict read-only mode: we do NOT pass any flags that would automate user
 * interactions; we only enable the debugging port and a profile dir.
 */
export async function launchBrowser(
  opts: LaunchOptions,
  cfg: AppConfig,
): Promise<LaunchedBrowser> {
  const log = getLogger();
  const port = opts.port ?? cfg.browser.port;
  const userDataDir = ensureDir(opts.userDataDir ?? cfg.browser.userDataDir);
  const browserPath = resolveBrowserPath(opts, cfg);

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
  ];
  if (cfg.browser.noFirstRun) {
    args.push("--no-first-run", "--no-default-browser-check");
  }
  if (opts.headless ?? cfg.browser.headless) {
    args.push("--headless=new");
  }
  for (const a of cfg.browser.extraArgs) args.push(a);
  for (const a of opts.extraArgs ?? []) args.push(a);

  log.info(
    { browserPath, port, userDataDir, args },
    "Launching browser with remote debugging",
  );

  const child = spawn(browserPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Poll the debugging endpoint until it answers, or timeout.
  const endpoint = await waitForDebuggerEndpoint(
    port,
    cfg.browser.healthCheckTimeoutMs * 4,
  );

  return {
    pid: child.pid ?? -1,
    endpoint,
    port,
    userDataDir,
    child,
  };
}

export async function waitForDebuggerEndpoint(
  port: number,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        // a short per-attempt timeout
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Browser debugger did not become reachable on port ${port} within ${timeoutMs}ms${
      lastErr ? `: ${(lastErr as Error).message}` : ""
    }`,
  );
}
