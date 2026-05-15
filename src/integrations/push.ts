import type { AppConfig, PushChannel } from "../config/schema.js";
import { getLogger } from "../utils/logger.js";
import { pushSummary as pushNotionSummary } from "./notion.js";

export interface PushSummaryRequest {
  /** Markdown summary file path on disk. */
  summaryPath: string;
  /** Title to use (e.g. "AI 圈每日简报 - 2026-05-14"). */
  title: string;
  /** Already-loaded markdown content (avoids second read for non-notion). */
  markdown: string;
  /** Optional list of channel names to push to; default: all enabled. */
  channels?: string[];
}

export interface PushChannelResult {
  channel: string;
  type: PushChannel["type"];
  ok: boolean;
  detail?: string;
  errorMessage?: string;
}

export interface PushOutcome {
  results: PushChannelResult[];
  okCount: number;
  failCount: number;
  skippedCount: number;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

/**
 * Convert Markdown to "Slack-friendly" mrkdwn-ish text. We DON'T do full
 * conversion; we strip Markdown heading hashes and rely on bullets being kept.
 */
function toSlackText(md: string, maxLen = 35_000): string {
  const out = md
    .replace(/^###\s+/gm, "*")
    .replace(/^##\s+/gm, "*")
    .replace(/^#\s+/gm, "*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*");
  return truncate(out, maxLen);
}

/** Discord webhook content limit is 2000 chars (the simple field). */
function toDiscordChunks(md: string): string[] {
  const chunks: string[] = [];
  let buf = "";
  for (const line of md.split(/\r?\n/)) {
    if (buf.length + line.length + 1 > 1900) {
      chunks.push(buf);
      buf = "";
    }
    buf += line + "\n";
  }
  if (buf.trim().length > 0) chunks.push(buf);
  return chunks.slice(0, 20);
}

/** Telegram bot API messages — 4096 char limit. */
function toTelegramChunks(md: string): string[] {
  const chunks: string[] = [];
  let buf = "";
  for (const line of md.split(/\r?\n/)) {
    if (buf.length + line.length + 1 > 3800) {
      chunks.push(buf);
      buf = "";
    }
    buf += line + "\n";
  }
  if (buf.trim().length > 0) chunks.push(buf);
  return chunks.slice(0, 20);
}

async function sendWebhook(
  channel: PushChannel,
  req: PushSummaryRequest,
): Promise<PushChannelResult> {
  if (!channel.url) {
    return {
      channel: channel.name || "webhook",
      type: "webhook",
      ok: false,
      errorMessage: "webhook channel missing url",
    };
  }
  try {
    const body = JSON.stringify({
      title: req.title,
      markdown: req.markdown,
    });
    const resp = await fetch(channel.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!resp.ok) {
      return {
        channel: channel.name || "webhook",
        type: "webhook",
        ok: false,
        errorMessage: `HTTP ${resp.status}`,
      };
    }
    return {
      channel: channel.name || "webhook",
      type: "webhook",
      ok: true,
      detail: `status ${resp.status}`,
    };
  } catch (err) {
    return {
      channel: channel.name || "webhook",
      type: "webhook",
      ok: false,
      errorMessage: (err as Error).message,
    };
  }
}

async function sendSlack(
  channel: PushChannel,
  req: PushSummaryRequest,
): Promise<PushChannelResult> {
  if (!channel.url) {
    return {
      channel: channel.name || "slack",
      type: "slack",
      ok: false,
      errorMessage: "slack channel missing webhook url",
    };
  }
  try {
    const text = `*${req.title}*\n\n${toSlackText(req.markdown)}`;
    const resp = await fetch(channel.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) {
      return {
        channel: channel.name || "slack",
        type: "slack",
        ok: false,
        errorMessage: `HTTP ${resp.status}`,
      };
    }
    return {
      channel: channel.name || "slack",
      type: "slack",
      ok: true,
    };
  } catch (err) {
    return {
      channel: channel.name || "slack",
      type: "slack",
      ok: false,
      errorMessage: (err as Error).message,
    };
  }
}

async function sendDiscord(
  channel: PushChannel,
  req: PushSummaryRequest,
): Promise<PushChannelResult> {
  if (!channel.url) {
    return {
      channel: channel.name || "discord",
      type: "discord",
      ok: false,
      errorMessage: "discord channel missing webhook url",
    };
  }
  try {
    const chunks = toDiscordChunks(`**${req.title}**\n\n${req.markdown}`);
    for (const c of chunks) {
      const resp = await fetch(channel.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: c }),
      });
      if (!resp.ok) {
        return {
          channel: channel.name || "discord",
          type: "discord",
          ok: false,
          errorMessage: `HTTP ${resp.status}`,
        };
      }
    }
    return {
      channel: channel.name || "discord",
      type: "discord",
      ok: true,
      detail: `${chunks.length} message(s)`,
    };
  } catch (err) {
    return {
      channel: channel.name || "discord",
      type: "discord",
      ok: false,
      errorMessage: (err as Error).message,
    };
  }
}

async function sendTelegram(
  channel: PushChannel,
  req: PushSummaryRequest,
): Promise<PushChannelResult> {
  const tokenEnv = channel.apiKeyEnv || "TELEGRAM_BOT_TOKEN";
  const token = process.env[tokenEnv];
  if (!token) {
    return {
      channel: channel.name || "telegram",
      type: "telegram",
      ok: false,
      errorMessage: `env var ${tokenEnv} not set`,
    };
  }
  if (!channel.chatId) {
    return {
      channel: channel.name || "telegram",
      type: "telegram",
      ok: false,
      errorMessage: "telegram channel missing chatId",
    };
  }
  try {
    const chunks = toTelegramChunks(`*${req.title}*\n\n${req.markdown}`);
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    for (const c of chunks) {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: channel.chatId,
          text: c,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        return {
          channel: channel.name || "telegram",
          type: "telegram",
          ok: false,
          errorMessage: `HTTP ${resp.status}: ${body.slice(0, 200)}`,
        };
      }
    }
    return {
      channel: channel.name || "telegram",
      type: "telegram",
      ok: true,
      detail: `${chunks.length} message(s)`,
    };
  } catch (err) {
    return {
      channel: channel.name || "telegram",
      type: "telegram",
      ok: false,
      errorMessage: (err as Error).message,
    };
  }
}

async function sendNotion(
  channel: PushChannel,
  req: PushSummaryRequest,
  cfg: AppConfig,
): Promise<PushChannelResult> {
  try {
    const result = await pushNotionSummary(
      {
        summaryPath: req.summaryPath,
        parentPageId: null,
        titleOverride: req.title,
      },
      cfg,
    );
    return {
      channel: channel.name || "notion",
      type: "notion",
      ok: true,
      detail: `${result.blockCount} blocks → ${result.pageId}`,
    };
  } catch (err) {
    return {
      channel: channel.name || "notion",
      type: "notion",
      ok: false,
      errorMessage: (err as Error).message,
    };
  }
}

export async function pushToChannels(
  req: PushSummaryRequest,
  cfg: AppConfig,
): Promise<PushOutcome> {
  const log = getLogger();
  const wantNames = req.channels ? new Set(req.channels) : null;
  const targets = cfg.push.channels.filter(
    (c) => c.enabled && (!wantNames || wantNames.has(c.name) || wantNames.has(c.type)),
  );
  if (targets.length === 0) {
    log.warn("No push channels configured/enabled");
    return { results: [], okCount: 0, failCount: 0, skippedCount: 0 };
  }
  const results: PushChannelResult[] = [];
  for (const ch of targets) {
    let r: PushChannelResult;
    switch (ch.type) {
      case "notion":
        r = await sendNotion(ch, req, cfg);
        break;
      case "webhook":
        r = await sendWebhook(ch, req);
        break;
      case "slack":
        r = await sendSlack(ch, req);
        break;
      case "discord":
        r = await sendDiscord(ch, req);
        break;
      case "telegram":
        r = await sendTelegram(ch, req);
        break;
      default:
        r = {
          channel: ch.name || ch.type,
          type: ch.type,
          ok: false,
          errorMessage: `unknown channel type: ${String(ch.type)}`,
        };
    }
    results.push(r);
    log.info({ channel: r.channel, ok: r.ok, err: r.errorMessage }, "push channel result");
  }
  return {
    results,
    okCount: results.filter((r) => r.ok).length,
    failCount: results.filter((r) => !r.ok).length,
    skippedCount: 0,
  };
}
