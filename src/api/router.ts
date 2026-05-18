import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/schema.js";
import type { LoadedPack } from "../config/packs.js";
import { StatusStore } from "../storage/statusStore.js";
import { sendIpc } from "../cli/ipc.js";
import { getLogger } from "../utils/logger.js";

export interface ApiServerOptions {
  port: number;
  host: string;
  cfg: AppConfig;
  packs: LoadedPack[];
  apiKeys?: string[];
}

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type",
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function buildRoutes(opts: ApiServerOptions): Route[] {
  const { cfg, packs, apiKeys } = opts;
  const routes: Route[] = [];

  function addRoute(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const patternStr = path.replace(/:(\w+)/g, (_match, name: string) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    routes.push({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${patternStr}$`),
      paramNames,
      handler,
    });
  }

  function requireAuth(
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean {
    if (!apiKeys || apiKeys.length === 0) return true;
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    if (apiKeys.includes(token)) return true;
    json(res, 401, { error: "unauthorized", message: "Invalid or missing API key" });
    return false;
  }

  // --- Health ---
  addRoute("GET", "/api/v1/health", (_req, res) => {
    const status = StatusStore.load(cfg.paths.statusFile);
    json(res, 200, {
      ok: true,
      version: "0.2.0",
      uptime: process.uptime(),
      collector: status?.state ?? "unknown",
    });
  });

  // --- Status ---
  addRoute("GET", "/api/v1/status", (req, res) => {
    if (!requireAuth(req, res)) return;
    const status = StatusStore.load(cfg.paths.statusFile);
    json(res, 200, { ok: true, data: status });
  });

  // --- Packs ---
  addRoute("GET", "/api/v1/packs", (req, res) => {
    if (!requireAuth(req, res)) return;
    const data = packs.map((p) => ({
      name: p.pack.name,
      description: p.pack.description,
      version: p.pack.version,
      audience: p.pack.audience,
      language: p.pack.language,
      topicCount: Object.keys(p.pack.topics).length,
      pushChannels: p.pack.pushChannels,
    }));
    json(res, 200, { ok: true, data });
  });

  // --- Summaries list ---
  addRoute("GET", "/api/v1/summaries", (req, res) => {
    if (!requireAuth(req, res)) return;
    if (!existsSync(cfg.paths.summariesDir)) {
      json(res, 200, { ok: true, data: [] });
      return;
    }
    const files = readdirSync(cfg.paths.summariesDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        name: f,
        mtime: statSync(join(cfg.paths.summariesDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 50);
    json(res, 200, { ok: true, data: files });
  });

  // --- Single summary ---
  addRoute("GET", "/api/v1/summaries/:name", (req, res, params) => {
    if (!requireAuth(req, res)) return;
    const name = params.name ?? "";
    if (!/^[A-Za-z0-9._-]+\.md$/.test(name)) {
      json(res, 400, { ok: false, error: "invalid summary name" });
      return;
    }
    const path = join(cfg.paths.summariesDir, name);
    if (!existsSync(path)) {
      json(res, 404, { ok: false, error: "not found" });
      return;
    }
    const markdown = readFileSync(path, "utf8");
    json(res, 200, { ok: true, data: { name, markdown } });
  });

  // --- Aggregates list ---
  addRoute("GET", "/api/v1/aggregates", (req, res) => {
    if (!requireAuth(req, res)) return;
    if (!existsSync(cfg.paths.aggregatesDir)) {
      json(res, 200, { ok: true, data: [] });
      return;
    }
    const files = readdirSync(cfg.paths.aggregatesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const m = f.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.json$/);
        return {
          name: f,
          date: m?.[1] ?? "?",
          pack: m?.[2] ?? "default",
          mtime: statSync(join(cfg.paths.aggregatesDir, f)).mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 50);
    json(res, 200, { ok: true, data: files });
  });

  // --- Single aggregate ---
  addRoute("GET", "/api/v1/aggregates/:name", (req, res, params) => {
    if (!requireAuth(req, res)) return;
    const name = params.name ?? "";
    if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) {
      json(res, 400, { ok: false, error: "invalid aggregate name" });
      return;
    }
    const path = join(cfg.paths.aggregatesDir, name);
    if (!existsSync(path)) {
      json(res, 404, { ok: false, error: "not found" });
      return;
    }
    const raw = readFileSync(path, "utf8");
    json(res, 200, { ok: true, data: JSON.parse(raw) as unknown });
  });

  // --- IPC control: pause / resume / stop ---
  addRoute("POST", "/api/v1/control/:action", async (req, res, params) => {
    if (!requireAuth(req, res)) return;
    const action = params.action ?? "";
    if (!["pause", "resume", "stop"].includes(action)) {
      json(res, 400, { ok: false, error: `unknown action: ${action}` });
      return;
    }
    try {
      const resp = await sendIpc(
        cfg.paths.ipcSocket,
        { cmd: action as "pause" | "resume" | "stop" },
        5000,
      );
      json(res, 200, resp);
    } catch (err) {
      json(res, 502, { ok: false, error: (err as Error).message });
    }
  });

  // --- Webhook trigger (12-Factor F11) ---
  addRoute("POST", "/api/v1/trigger", async (req, res) => {
    if (!requireAuth(req, res)) return;
    const body = await readBody(req);
    let payload: Record<string, unknown> = {};
    try {
      if (body.trim()) payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      json(res, 400, { ok: false, error: "invalid JSON body" });
      return;
    }
    const log = getLogger();
    log.info({ source: "api", payload }, "external trigger received");
    json(res, 202, {
      ok: true,
      message: "trigger accepted",
      payload,
    });
  });

  // --- Subscription info (OPC product pool) ---
  addRoute("GET", "/api/v1/subscription", (req, res) => {
    if (!requireAuth(req, res)) return;
    const tier = process.env.XINTEL_SUBSCRIPTION_TIER ?? "free";
    json(res, 200, {
      ok: true,
      data: {
        tier,
        activePacks: packs.map((p) => p.pack.name),
        features: tierFeatures(tier),
      },
    });
  });

  return routes;
}

function tierFeatures(tier: string): Record<string, boolean> {
  switch (tier) {
    case "pro":
      return { api: true, llm: true, multiPack: true, webhook: true, priority: true };
    case "basic":
      return { api: true, llm: true, multiPack: false, webhook: true, priority: false };
    default:
      return { api: true, llm: false, multiPack: false, webhook: false, priority: false };
  }
}

export function startApiServer(opts: ApiServerOptions): {
  stop: () => Promise<void>;
  url: string;
} {
  const log = getLogger();
  const routes = buildRoutes(opts);

  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${opts.port}`);
    const method = (req.method ?? "GET").toUpperCase();

    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;

      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]!] = decodeURIComponent(match[i + 1] ?? "");
      }

      try {
        await route.handler(req, res, params);
      } catch (err) {
        log.error({ err: (err as Error).message, path: url.pathname }, "API handler error");
        json(res, 500, { ok: false, error: "internal error" });
      }
      return;
    }

    json(res, 404, { ok: false, error: "not found" });
  });

  server.listen(opts.port, opts.host);
  const listenUrl = `http://${opts.host}:${opts.port}`;
  log.info({ url: listenUrl }, "API server started");

  return {
    url: listenUrl,
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}
