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
  logging: z.object({
    level: z.string().default("info"),
    prettyPrint: z.boolean().default(true),
  }),
  paths: z.object({
    dataDir: z.string().default("data"),
    runsDir: z.string().default("data/runs"),
    summariesDir: z.string().default("data/summaries"),
    logsDir: z.string().default("data/logs"),
    statusFile: z.string().default("data/latest-status.json"),
    lockFile: z.string().default("data/.lock"),
    ipcSocket: z.string().default("data/xintel.sock"),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
