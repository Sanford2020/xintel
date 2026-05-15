import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { getLogger } from "../utils/logger.js";

export interface BrowserStatus {
  reachable: boolean;
  port: number;
  endpoint?: string;
  browserVersion?: string;
  userAgent?: string;
  error?: string;
}

export interface ConnectedBrowser {
  browser: Browser;
  context: BrowserContext;
  endpoint: string;
  close: () => Promise<void>;
}

export async function checkBrowserStatus(
  port: number,
  timeoutMs = 3000,
): Promise<BrowserStatus> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { reachable: false, port, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      Browser?: string;
      "User-Agent"?: string;
      webSocketDebuggerUrl?: string;
    };
    return {
      reachable: true,
      port,
      browserVersion: body.Browser,
      userAgent: body["User-Agent"],
      endpoint: body.webSocketDebuggerUrl,
    };
  } catch (err) {
    return { reachable: false, port, error: (err as Error).message };
  }
}

export async function connectBrowser(port: number): Promise<ConnectedBrowser> {
  const log = getLogger();
  const status = await checkBrowserStatus(port);
  if (!status.reachable || !status.endpoint) {
    throw new Error(
      `Cannot connect to browser on port ${port}: ${status.error ?? "no endpoint"}. ` +
        `Did you run 'xintel browser launch'?`,
    );
  }

  log.info({ endpoint: status.endpoint }, "Connecting to browser via CDP");
  const browser = await chromium.connectOverCDP(status.endpoint);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error(
      `Browser has no open contexts; please open at least one tab and sign in to X.com first.`,
    );
  }
  const context = contexts[0]!;

  return {
    browser,
    context,
    endpoint: status.endpoint,
    close: async () => {
      try {
        await browser.close();
      } catch {
        // ignore: we did not own the browser process
      }
    },
  };
}

export async function getActivePage(context: BrowserContext): Promise<Page> {
  const pages = context.pages();
  if (pages.length > 0) return pages[0]!;
  return context.newPage();
}
