import { describe, expect, it } from "vitest";
import { summarize } from "../src/analysis/summarize.js";
import { ConfigSchema } from "../src/config/schema.js";
import type { RoundRecord, TweetRecord } from "../src/types/index.js";

function tw(text: string, id: string, handle = "@u"): TweetRecord {
  return {
    id,
    permalink: `https://x.com/u/status/${id}`,
    author: "U",
    handle,
    textRaw: text,
    textNorm: text,
    capturedAt: new Date().toISOString(),
    hasMedia: false,
    isRepost: false,
    links: [],
    hashtags: [],
    mentions: [],
    source: { pageType: "search", pageName: "Search: ai-frontier", round: 1 },
  };
}

describe("summarize", () => {
  it("produces a markdown briefing with sections", async () => {
    const config = ConfigSchema.parse({
      browser: {},
      schedule: {},
      sources: { for_you: {}, following: {}, explore: {}, trends: {}, lists: {}, search: { queries: [] } },
      classify: {
        topics: {
          ai_agent: { label: "AI Agent", keywords: ["openai", "agent"] },
        },
        fallbackTopic: "other",
      },
      dedupe: { minTextLength: 4, shingleSize: 4, similarityThreshold: 0.9 },
      notion: {},
      logging: {},
      paths: {},
    });

    const round: RoundRecord = {
      round: 1,
      startedAt: "2024-01-01T00:00:00Z",
      finishedAt: "2024-01-01T00:01:00Z",
      durationMs: 60_000,
      meta: { appVersion: "0.1.0", configHash: "abc", browserEndpoint: "ws://x" },
      pages: [
        {
          type: "search",
          name: "Search: ai-frontier",
          url: "https://x.com/search?q=AI",
          finalUrl: "https://x.com/search?q=AI",
          title: "AI search",
          startedAt: "2024-01-01T00:00:00Z",
          finishedAt: "2024-01-01T00:00:10Z",
          batches: 3,
          tweets: [
            tw("OpenAI launches new coding agent", "1"),
            tw("OpenAI launches new coding agent", "1"),
            tw("Rumor: secret chip deal between huge company and Beijing", "2"),
            tw("Buy now! Giveaway airdrop crypto bonus", "3"),
          ],
        },
      ],
    };

    const { summary, markdown } = await summarize({ runId: "test", rounds: [round], config });
    expect(summary.raw).toBe(4);
    expect(summary.deduped).toBeLessThan(4);
    expect(markdown).toMatch(/X 情报采集简报/);
    expect(markdown).toMatch(/需要核验的传言/);
    expect(markdown).toMatch(/噪声与风险/);
  });
});
