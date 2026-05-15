import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import type { AppConfig } from "../config/schema.js";
import type { LoadedPack } from "../config/packs.js";
import { StatusStore } from "../storage/statusStore.js";
import { getLogger } from "../utils/logger.js";

export interface ServeOptions {
  port: number;
  cfg: AppConfig;
  packs: LoadedPack[];
}

interface SummaryFileEntry {
  name: string;
  path: string;
  mtime: number;
}

function listSummaries(cfg: AppConfig): SummaryFileEntry[] {
  if (!existsSync(cfg.paths.summariesDir)) return [];
  return readdirSync(cfg.paths.summariesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      name: f,
      path: join(cfg.paths.summariesDir, f),
      mtime: statSync(join(cfg.paths.summariesDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
}

function listAggregates(cfg: AppConfig): {
  date: string;
  pack: string;
  name: string;
  mtime: number;
}[] {
  if (!existsSync(cfg.paths.aggregatesDir)) return [];
  return readdirSync(cfg.paths.aggregatesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.json$/);
      return {
        date: m?.[1] ?? "?",
        pack: m?.[2] ?? "default",
        name: f,
        mtime: statSync(join(cfg.paths.aggregatesDir, f)).mtimeMs,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

const ESC_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC_MAP[c] ?? c);
}

function homePage(cfg: AppConfig, packs: LoadedPack[]): string {
  const summaries = listSummaries(cfg).slice(0, 30);
  const aggs = listAggregates(cfg).slice(0, 30);
  const status = StatusStore.load(cfg.paths.statusFile);

  const packsRows = packs
    .map(
      (p) =>
        `<tr><td><code>${escapeHtml(p.pack.name)}</code></td><td>${escapeHtml(p.pack.description)}</td><td>${Object.keys(p.pack.topics).length}</td></tr>`,
    )
    .join("");
  const summariesRows = summaries
    .map(
      (s) =>
        `<tr><td><a href="/summary/${encodeURIComponent(s.name)}">${escapeHtml(s.name)}</a></td><td>${new Date(s.mtime).toISOString()}</td></tr>`,
    )
    .join("");
  const aggRows = aggs
    .map(
      (a) =>
        `<tr><td>${escapeHtml(a.date)}</td><td><code>${escapeHtml(a.pack)}</code></td><td><a href="/aggregate/${encodeURIComponent(a.name)}">${escapeHtml(a.name)}</a></td></tr>`,
    )
    .join("");

  const statusBlock = status
    ? `<dl>
        <dt>state</dt><dd><code>${escapeHtml(status.state)}</code></dd>
        <dt>currentRound</dt><dd>${status.currentRound} / ${status.totalRounds}</dd>
        <dt>runId</dt><dd><code>${escapeHtml(status.runId)}</code></dd>
        <dt>updatedAt</dt><dd>${escapeHtml(status.updatedAt)}</dd>
        ${status.lastError ? `<dt>lastError</dt><dd style="color:#c00">${escapeHtml(status.lastError)}</dd>` : ""}
       </dl>`
    : `<p><em>No status recorded yet — run <code>xintel collect</code> first.</em></p>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>xintel · dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:960px;margin:32px auto;padding:0 16px;color:#222;}
  h1{font-size:24px;margin:0 0 8px;}
  h2{font-size:18px;margin:24px 0 8px;border-bottom:1px solid #eee;padding-bottom:4px;}
  table{width:100%;border-collapse:collapse;font-size:14px;}
  th,td{padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:left;vertical-align:top;}
  code{background:#f4f4f4;padding:1px 4px;border-radius:3px;font-size:12px;}
  dl{display:grid;grid-template-columns:140px 1fr;row-gap:4px;font-size:14px;}
  dt{color:#666;}
  a{color:#0a58ca;}
  .badge{display:inline-block;padding:2px 6px;background:#0a58ca;color:#fff;border-radius:3px;font-size:11px;margin-left:6px;}
</style>
</head>
<body>
  <h1>xintel <span class="badge">v0.2</span></h1>
  <p>Local-only X.com intelligence platform · read-only · BYOK LLM · multi-pack.</p>

  <h2>Current run status</h2>
  ${statusBlock}

  <h2>Enabled segment packs (${packs.length})</h2>
  ${packs.length === 0 ? "<p><em>No packs enabled. Set <code>packs.enabled</code> in <code>config/local.json</code>.</em></p>" : `<table><thead><tr><th>Name</th><th>Description</th><th># topics</th></tr></thead><tbody>${packsRows}</tbody></table>`}

  <h2>Recent briefings (${summaries.length})</h2>
  ${summaries.length === 0 ? "<p><em>No briefings yet — run <code>xintel summarize</code>.</em></p>" : `<table><thead><tr><th>File</th><th>Generated</th></tr></thead><tbody>${summariesRows}</tbody></table>`}

  <h2>Daily aggregates (${aggs.length})</h2>
  ${aggs.length === 0 ? "<p><em>No aggregates yet.</em></p>" : `<table><thead><tr><th>Date</th><th>Pack</th><th>File</th></tr></thead><tbody>${aggRows}</tbody></table>`}

  <h2>Endpoints</h2>
  <ul>
    <li><code>GET /</code> — this page</li>
    <li><code>GET /api/status</code> — current run status JSON</li>
    <li><code>GET /api/packs</code> — list of enabled packs</li>
    <li><code>GET /api/summaries</code> — list of briefing files</li>
    <li><code>GET /api/aggregates</code> — list of daily aggregate files</li>
    <li><code>GET /summary/&lt;name&gt;</code> — rendered Markdown briefing</li>
    <li><code>GET /aggregate/&lt;name&gt;</code> — raw aggregate JSON</li>
  </ul>
  <p style="color:#888;font-size:12px;margin-top:32px">Auto-refresh disabled. Reload to see latest data.</p>
</body>
</html>`;
}

function summaryPage(cfg: AppConfig, name: string): { status: number; body: string; contentType: string } {
  if (!/^[A-Za-z0-9._-]+\.md$/.test(name)) {
    return { status: 400, body: "invalid summary name", contentType: "text/plain; charset=utf-8" };
  }
  const path = join(cfg.paths.summariesDir, name);
  if (!existsSync(path)) {
    return { status: 404, body: "not found", contentType: "text/plain; charset=utf-8" };
  }
  const md = readFileSync(path, "utf8");
  const html = marked.parse(md, { async: false }) as string;
  const body = `<!doctype html><html><head><meta charset="utf-8" /><title>${escapeHtml(name)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:880px;margin:32px auto;padding:0 16px;color:#222;line-height:1.55;}
h1,h2,h3{border-bottom:1px solid #eee;padding-bottom:4px;}code{background:#f4f4f4;padding:1px 4px;border-radius:3px;}blockquote{border-left:3px solid #ffc107;background:#fff8e1;padding:8px 12px;margin:12px 0;}a{color:#0a58ca;}</style>
</head><body><p><a href="/">&larr; back</a></p>${html}</body></html>`;
  return { status: 200, body, contentType: "text/html; charset=utf-8" };
}

function aggregatePage(cfg: AppConfig, name: string): { status: number; body: string; contentType: string } {
  if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) {
    return { status: 400, body: "invalid aggregate name", contentType: "text/plain; charset=utf-8" };
  }
  const path = join(cfg.paths.aggregatesDir, name);
  if (!existsSync(path)) {
    return { status: 404, body: "not found", contentType: "text/plain; charset=utf-8" };
  }
  const body = readFileSync(path, "utf8");
  return { status: 200, body, contentType: "application/json; charset=utf-8" };
}

export function startServer(opts: ServeOptions): { stop: () => Promise<void>; url: string } {
  const { port, cfg, packs } = opts;
  const log = getLogger();

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const path = url.pathname;

      const send = (status: number, body: string, contentType = "text/html; charset=utf-8") => {
        res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
        res.end(body);
      };

      if (path === "/" || path === "/index.html") {
        send(200, homePage(cfg, packs));
        return;
      }
      if (path === "/api/status") {
        const st = StatusStore.load(cfg.paths.statusFile);
        send(200, JSON.stringify(st ?? null, null, 2), "application/json; charset=utf-8");
        return;
      }
      if (path === "/api/packs") {
        const data = packs.map((p) => ({
          name: p.pack.name,
          description: p.pack.description,
          version: p.pack.version,
          audience: p.pack.audience,
          topicCount: Object.keys(p.pack.topics).length,
          pushChannels: p.pack.pushChannels,
        }));
        send(200, JSON.stringify(data, null, 2), "application/json; charset=utf-8");
        return;
      }
      if (path === "/api/summaries") {
        send(200, JSON.stringify(listSummaries(cfg), null, 2), "application/json; charset=utf-8");
        return;
      }
      if (path === "/api/aggregates") {
        send(200, JSON.stringify(listAggregates(cfg), null, 2), "application/json; charset=utf-8");
        return;
      }
      if (path.startsWith("/summary/")) {
        const name = decodeURIComponent(path.slice("/summary/".length));
        const r = summaryPage(cfg, name);
        send(r.status, r.body, r.contentType);
        return;
      }
      if (path.startsWith("/aggregate/")) {
        const name = decodeURIComponent(path.slice("/aggregate/".length));
        const r = aggregatePage(cfg, name);
        send(r.status, r.body, r.contentType);
        return;
      }
      send(404, "not found", "text/plain; charset=utf-8");
    } catch (err) {
      const msg = (err as Error).message;
      log.error({ err: msg }, "serve handler error");
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("internal error");
    }
  });

  server.listen(port, "127.0.0.1");
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
