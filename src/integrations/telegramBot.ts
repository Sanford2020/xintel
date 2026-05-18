import { getLogger } from "../utils/logger.js";

export interface TelegramBotConfig {
  token: string;
  chatId: string;
  pollingIntervalMs: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
    date: number;
  };
}

export type CommandHandler = (
  chatId: string,
  args: string,
  from: string,
) => Promise<string>;

export class TelegramBot {
  private readonly token: string;
  private readonly allowedChatIds: Set<string>;
  private readonly pollingMs: number;
  private offset = 0;
  private running = false;
  private commands = new Map<string, CommandHandler>();
  private abortController: AbortController | null = null;

  constructor(config: TelegramBotConfig) {
    this.token = config.token;
    this.allowedChatIds = new Set(
      config.chatId.split(",").map((s) => s.trim()).filter(Boolean),
    );
    this.pollingMs = config.pollingIntervalMs;
  }

  registerCommand(name: string, handler: CommandHandler): void {
    this.commands.set(name.toLowerCase(), handler);
  }

  async sendMessage(chatId: string, text: string, parseMode = "Markdown"): Promise<boolean> {
    const log = getLogger();
    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: text.slice(0, 4000),
            parse_mode: parseMode,
            disable_web_page_preview: true,
          }),
        },
      );
      if (!resp.ok) {
        const body = await resp.text();
        log.warn({ status: resp.status, body: body.slice(0, 200) }, "Telegram send failed");
        return false;
      }
      return true;
    } catch (err) {
      log.error({ err: (err as Error).message }, "Telegram send error");
      return false;
    }
  }

  async alertHuman(message: string): Promise<void> {
    for (const chatId of this.allowedChatIds) {
      await this.sendMessage(chatId, message);
    }
  }

  async startPolling(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    const log = getLogger();
    log.info("Telegram bot polling started");

    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        if (!this.running) break;
        log.warn({ err: (err as Error).message }, "Telegram poll error");
      }
      if (!this.running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.pollingMs);
        this.abortController?.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }

  stopPolling(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  private async pollOnce(): Promise<void> {
    const log = getLogger();
    const resp = await fetch(
      `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=10&allowed_updates=["message"]`,
    );
    if (!resp.ok) return;

    const data = (await resp.json()) as { ok: boolean; result: TelegramUpdate[] };
    if (!data.ok || !data.result) return;

    for (const update of data.result) {
      this.offset = update.update_id + 1;
      const msg = update.message;
      if (!msg?.text) continue;

      const chatId = String(msg.chat.id);
      if (!this.allowedChatIds.has(chatId)) {
        log.debug({ chatId }, "Ignoring message from unauthorized chat");
        continue;
      }

      const text = msg.text.trim();
      if (!text.startsWith("/")) continue;

      const parts = text.split(/\s+/);
      const cmdName = (parts[0] ?? "").slice(1).toLowerCase().split("@")[0] ?? "";
      const args = parts.slice(1).join(" ");
      const from = msg.from?.username ?? msg.from?.first_name ?? "unknown";

      const handler = this.commands.get(cmdName);
      if (!handler) {
        await this.sendMessage(chatId, `Unknown command: /${cmdName}\nAvailable: ${Array.from(this.commands.keys()).map((c) => `/${c}`).join(", ")}`);
        continue;
      }

      log.info({ cmd: cmdName, from, chatId }, "Telegram command received");
      try {
        const reply = await handler(chatId, args, from);
        await this.sendMessage(chatId, reply);
      } catch (err) {
        log.error({ err: (err as Error).message, cmd: cmdName }, "Telegram command error");
        await this.sendMessage(chatId, `Error: ${(err as Error).message}`);
      }
    }
  }
}

export function buildTelegramBot(): TelegramBot | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;

  const bot = new TelegramBot({
    token,
    chatId,
    pollingIntervalMs: 3000,
  });
  return bot;
}

export function registerDefaultCommands(
  bot: TelegramBot,
  getStatus: () => unknown,
  getLastSummary: () => string | null,
): void {
  bot.registerCommand("status", async () => {
    const status = getStatus();
    if (!status) return "No collector status available. Run `xintel collect` first.";
    return `\`\`\`\n${JSON.stringify(status, null, 2)}\n\`\`\``;
  });

  bot.registerCommand("summary", async () => {
    const md = getLastSummary();
    if (!md) return "No summaries available yet.";
    return md.slice(0, 3800);
  });

  bot.registerCommand("help", async () => {
    return [
      "*xintel Bot Commands*",
      "/status - Show collector status",
      "/summary - Show latest briefing",
      "/help - Show this message",
    ].join("\n");
  });
}
