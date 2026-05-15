import { z } from "zod";

export const SearchQuerySchema = z.object({
  name: z.string().min(1),
  q: z.string().min(1),
  live: z.boolean().default(true),
});

export const ListEntrySchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
});

export const TopicDefSchema = z.object({
  label: z.string(),
  keywords: z.array(z.string()).default([]),
  /**
   * Optional priority signal handles whose mentions on this topic should be
   * highlighted (e.g. official accounts to watch). Pure metadata; never used
   * for any write action.
   */
  watchHandles: z.array(z.string()).default([]),
});

export const PushChannelSchema = z.object({
  type: z.enum(["notion", "webhook", "slack", "discord", "telegram"]),
  enabled: z.boolean().default(true),
  /** Generic URL/webhook target (Slack/Discord/Webhook). */
  url: z.string().optional(),
  /** Env var name that holds the secret token (Telegram bot, custom). */
  apiKeyEnv: z.string().optional(),
  /** Telegram-specific chat id. */
  chatId: z.string().optional(),
  /** Friendly name to identify this channel in logs/UI. */
  name: z.string().default(""),
});

export const LlmSchema = z.object({
  /** If false, all LLM calls are skipped and rule-based logic is used. */
  enabled: z.boolean().default(false),
  provider: z.enum(["anthropic", "openai", "google", "none"]).default("none"),
  /** Model identifier (provider-specific). */
  model: z.string().default(""),
  /** Environment variable name to read the API key from. */
  apiKeyEnv: z.string().default(""),
  maxOutputTokens: z.number().int().positive().default(2000),
  temperature: z.number().min(0).max(2).default(0.3),
  timeoutMs: z.number().int().positive().default(60_000),
  /** Hard cap on calls per summarize run, to bound cost. */
  maxCallsPerSummary: z.number().int().positive().default(6),
});

export const ReportTemplateSchema = z.object({
  title: z.string().default("X 情报简报"),
  introNote: z.string().default(""),
  /** Headers to include, in order. Empty => use built-in default order. */
  sections: z.array(z.string()).default([]),
  includeTrends: z.boolean().default(true),
  includeRumors: z.boolean().default(true),
  includeAppendix: z.boolean().default(true),
  maxSamplesPerTopic: z.number().int().positive().default(8),
  /** "balanced" | "trader" | "researcher" | "media" | "analyst" — controls
   *  built-in copy; packs may set their own tone string and override
   *  llmSystemPrompt to fully customise wording. */
  reportTone: z.string().default("balanced"),
});

export const SegmentPackSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  version: z.string().default("0.1.0"),
  audience: z.string().default(""),
  /** Display language hint for the report; LLM prompt honours this. */
  language: z.enum(["zh", "en", "zh-en"]).default("zh"),

  searchQueries: z.array(SearchQuerySchema).default([]),
  lists: z.array(ListEntrySchema).default([]),

  topics: z.record(TopicDefSchema).default({}),
  fallbackTopic: z.string().default("other"),

  rumorHints: z.array(z.string()).default([]),
  noiseHints: z.array(z.string()).default([]),

  llmSystemPrompt: z.string().default(""),
  llmUserPromptTemplate: z.string().default(""),

  reportTemplate: ReportTemplateSchema.default({}),

  /** Names of push channels (see top-level push.channels) to deliver to. */
  pushChannels: z.array(z.string()).default([]),
});

export const PacksSchema = z.object({
  /** Names of built-in packs to enable. Resolved from config/packs/*.json. */
  enabled: z.array(z.string()).default([]),
  /** Extra search directories for pack JSON files (relative to project root). */
  searchPaths: z.array(z.string()).default(["config/packs"]),
});

export const HealthSchema = z.object({
  /** Alert if a page yields fewer than N tweets across this many consecutive
   *  rounds (signals likely DOM drift or login wall). */
  emptyRoundsThreshold: z.number().int().positive().default(3),
  /** If true, doctor will run a smoke probe against x.com (HTTP HEAD only). */
  probeNetwork: z.boolean().default(true),
});

export const ConfigSchema = z.object({
  browser: z.object({
    channel: z.enum(["chrome", "msedge", "chromium"]).default("chrome"),
    chromePath: z.string().optional(),
    port: z.number().int().positive().default(9224),
    userDataDir: z.string().default(".cache/xintel-profile"),
    headless: z.boolean().default(false),
    noFirstRun: z.boolean().default(true),
    extraArgs: z.array(z.string()).default([]),
    healthCheckTimeoutMs: z.number().int().positive().default(5000),
  }),
  schedule: z.object({
    rounds: z.number().int().positive().default(100),
    intervalMs: z.number().int().nonnegative().default(60_000),
    perPageTimeoutMs: z.number().int().positive().default(60_000),
    perPageScrollBatches: z.number().int().nonnegative().default(6),
    scrollDelayMs: z.number().int().nonnegative().default(1200),
    maxConsecutiveFailures: z.number().int().positive().default(5),
  }),
  sources: z.object({
    for_you: z.object({
      enabled: z.boolean().default(true),
      url: z.string().url().default("https://x.com/home"),
    }),
    following: z.object({
      enabled: z.boolean().default(true),
      url: z.string().url().default("https://x.com/home"),
    }),
    explore: z.object({
      enabled: z.boolean().default(true),
      url: z.string().url().default("https://x.com/explore"),
    }),
    trends: z.object({
      enabled: z.boolean().default(true),
      url: z.string().url().default("https://x.com/explore/tabs/trending"),
    }),
    lists: z.object({
      enabled: z.boolean().default(false),
      items: z.array(ListEntrySchema).default([]),
    }),
    search: z.object({
      enabled: z.boolean().default(true),
      queries: z.array(SearchQuerySchema).default([]),
    }),
  }),
  classify: z.object({
    topics: z.record(TopicDefSchema).default({}),
    fallbackTopic: z.string().default("other"),
  }),
  dedupe: z.object({
    minTextLength: z.number().int().nonnegative().default(8),
    shingleSize: z.number().int().positive().default(6),
    similarityThreshold: z.number().min(0).max(1).default(0.85),
  }),
  notion: z.object({
    parentPageId: z.string().nullable().default(null),
    titleTemplate: z.string().default("X 情报采集简报 - {date}"),
    maxBlocksPerRequest: z.number().int().positive().max(100).default(100),
  }),
  push: z.object({
    channels: z.array(PushChannelSchema).default([]),
  }).default({ channels: [] }),
  llm: LlmSchema.default({}),
  packs: PacksSchema.default({}),
  health: HealthSchema.default({}),
  logging: z.object({
    level: z.string().default("info"),
    prettyPrint: z.boolean().default(true),
  }),
  paths: z.object({
    dataDir: z.string().default("data"),
    runsDir: z.string().default("data/runs"),
    summariesDir: z.string().default("data/summaries"),
    logsDir: z.string().default("data/logs"),
    aggregatesDir: z.string().default("data/aggregates"),
    dashboardDir: z.string().default("data/dashboard"),
    statusFile: z.string().default("data/latest-status.json"),
    lockFile: z.string().default("data/.lock"),
    ipcSocket: z.string().default("data/xintel.sock"),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type SegmentPack = z.infer<typeof SegmentPackSchema>;
export type PushChannel = z.infer<typeof PushChannelSchema>;
export type LlmConfig = z.infer<typeof LlmSchema>;
export type ReportTemplate = z.infer<typeof ReportTemplateSchema>;
