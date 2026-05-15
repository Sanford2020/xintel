import { getLogger } from "../utils/logger.js";
import type { LlmConfig } from "../config/schema.js";

export interface LlmCallOptions {
  systemPrompt: string;
  userPrompt: string;
  /** Optional per-call override of the configured max output tokens. */
  maxTokens?: number;
  /** Optional per-call override of temperature. */
  temperature?: number;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

export interface LlmCallResult {
  text: string;
  provider: string;
  model: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
  latencyMs: number;
}

export interface LlmAdapter {
  readonly enabled: boolean;
  readonly provider: string;
  readonly model: string;
  /** Number of calls actually issued in this process (for cost budgeting). */
  readonly callsMade: number;
  /** Returns true once the per-summarize cap is reached. */
  isExhausted(): boolean;
  call(opts: LlmCallOptions): Promise<LlmCallResult | null>;
}

class DisabledAdapter implements LlmAdapter {
  enabled = false;
  provider = "none";
  model = "";
  callsMade = 0;
  isExhausted(): boolean {
    return true;
  }
  async call(): Promise<null> {
    return null;
  }
}

interface BaseAdapterOpts {
  cfg: LlmConfig;
  apiKey: string;
}

abstract class BaseAdapter implements LlmAdapter {
  enabled = true;
  abstract readonly provider: string;
  readonly model: string;
  callsMade = 0;
  protected readonly cfg: LlmConfig;
  protected readonly apiKey: string;
  constructor(opts: BaseAdapterOpts) {
    this.cfg = opts.cfg;
    this.apiKey = opts.apiKey;
    this.model = opts.cfg.model;
  }
  isExhausted(): boolean {
    return this.callsMade >= this.cfg.maxCallsPerSummary;
  }
  abstract call(opts: LlmCallOptions): Promise<LlmCallResult | null>;
}

class AnthropicAdapter extends BaseAdapter {
  provider = "anthropic";

  async call(opts: LlmCallOptions): Promise<LlmCallResult | null> {
    if (this.isExhausted()) return null;
    const log = getLogger();
    const startedAt = Date.now();
    const url = "https://api.anthropic.com/v1/messages";
    const body = {
      model: this.model || "claude-3-5-sonnet-20241022",
      max_tokens: opts.maxTokens ?? this.cfg.maxOutputTokens,
      temperature: opts.temperature ?? this.cfg.temperature,
      system: opts.systemPrompt,
      messages: [{ role: "user", content: opts.userPrompt }],
    };
    try {
      const resp = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: opts.signal,
        },
        this.cfg.timeoutMs,
      );
      if (!resp.ok) {
        const text = await resp.text();
        log.error(
          { status: resp.status, body: text.slice(0, 500) },
          "Anthropic call failed",
        );
        return null;
      }
      const json = (await resp.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (json.content ?? [])
        .map((c) => (c.type === "text" ? c.text ?? "" : ""))
        .join("\n")
        .trim();
      this.callsMade += 1;
      return {
        text,
        provider: this.provider,
        model: this.model,
        usage: {
          promptTokens: json.usage?.input_tokens,
          completionTokens: json.usage?.output_tokens,
        },
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      log.error({ err: (err as Error).message }, "Anthropic adapter error");
      return null;
    }
  }
}

class OpenAIAdapter extends BaseAdapter {
  provider = "openai";

  async call(opts: LlmCallOptions): Promise<LlmCallResult | null> {
    if (this.isExhausted()) return null;
    const log = getLogger();
    const startedAt = Date.now();
    const url = "https://api.openai.com/v1/chat/completions";
    const body = {
      model: this.model || "gpt-4o-mini",
      max_tokens: opts.maxTokens ?? this.cfg.maxOutputTokens,
      temperature: opts.temperature ?? this.cfg.temperature,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.userPrompt },
      ],
    };
    try {
      const resp = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: opts.signal,
        },
        this.cfg.timeoutMs,
      );
      if (!resp.ok) {
        const text = await resp.text();
        log.error(
          { status: resp.status, body: text.slice(0, 500) },
          "OpenAI call failed",
        );
        return null;
      }
      const json = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = (json.choices?.[0]?.message?.content ?? "").trim();
      this.callsMade += 1;
      return {
        text,
        provider: this.provider,
        model: this.model,
        usage: {
          promptTokens: json.usage?.prompt_tokens,
          completionTokens: json.usage?.completion_tokens,
        },
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      log.error({ err: (err as Error).message }, "OpenAI adapter error");
      return null;
    }
  }
}

class GoogleAdapter extends BaseAdapter {
  provider = "google";

  async call(opts: LlmCallOptions): Promise<LlmCallResult | null> {
    if (this.isExhausted()) return null;
    const log = getLogger();
    const startedAt = Date.now();
    const model = this.model || "gemini-1.5-pro-latest";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const body = {
      systemInstruction: { parts: [{ text: opts.systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: opts.userPrompt }] }],
      generationConfig: {
        maxOutputTokens: opts.maxTokens ?? this.cfg.maxOutputTokens,
        temperature: opts.temperature ?? this.cfg.temperature,
      },
    };
    try {
      const resp = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: opts.signal,
        },
        this.cfg.timeoutMs,
      );
      if (!resp.ok) {
        const text = await resp.text();
        log.error(
          { status: resp.status, body: text.slice(0, 500) },
          "Google call failed",
        );
        return null;
      }
      const json = (await resp.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const text = (json.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      this.callsMade += 1;
      return {
        text,
        provider: this.provider,
        model,
        usage: {
          promptTokens: json.usageMetadata?.promptTokenCount,
          completionTokens: json.usageMetadata?.candidatesTokenCount,
        },
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      log.error({ err: (err as Error).message }, "Google adapter error");
      return null;
    }
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Build an LLM adapter from config. If LLM is disabled, the provider is
 * "none", or the configured API key is missing from the environment, returns
 * a disabled adapter (callers should silently fall back to rule-based logic).
 */
export function buildLlmAdapter(cfg: LlmConfig): LlmAdapter {
  if (!cfg.enabled) return new DisabledAdapter();
  if (cfg.provider === "none") return new DisabledAdapter();
  const envName = cfg.apiKeyEnv || defaultEnvFor(cfg.provider);
  const apiKey = process.env[envName];
  if (!apiKey) {
    const log = getLogger();
    log.warn(
      { provider: cfg.provider, envName },
      "LLM enabled but API key env var not set — falling back to rule-based logic",
    );
    return new DisabledAdapter();
  }
  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicAdapter({ cfg, apiKey });
    case "openai":
      return new OpenAIAdapter({ cfg, apiKey });
    case "google":
      return new GoogleAdapter({ cfg, apiKey });
    default:
      return new DisabledAdapter();
  }
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
