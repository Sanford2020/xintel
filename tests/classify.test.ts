import { describe, expect, it } from "vitest";
import { classifyTweet } from "../src/analysis/classify.js";
import type { TweetRecord } from "../src/types/index.js";

const topics = {
  ai_agent: { label: "AI Agent / 编程工具链", keywords: ["openai", "claude", "agent"] },
  us_china: { label: "中美峰会 / 外交地缘", keywords: ["trump", "xi", "beijing"] },
  ai_chip: { label: "AI 芯片 / NVIDIA / 半导体", keywords: ["nvidia", "huang"] },
};

function mk(text: string): TweetRecord {
  return {
    textRaw: text,
    textNorm: text,
    capturedAt: new Date().toISOString(),
    hasMedia: false,
    isRepost: false,
    links: [],
    hashtags: [],
    mentions: [],
    source: { pageType: "search", pageName: "search", round: 1 },
  };
}

describe("classify", () => {
  it("picks highest-keyword-overlap topic", () => {
    const r = classifyTweet(mk("OpenAI launches a new coding agent product."), {
      topics, fallbackTopic: "other",
    });
    expect(r.topic).toBe("ai_agent");
    expect(r.topicScore).toBeGreaterThan(0);
  });

  it("falls back to other when nothing matches", () => {
    const r = classifyTweet(mk("My dog is cute"), {
      topics, fallbackTopic: "other",
    });
    expect(r.topic).toBe("other");
    expect(r.topicScore).toBe(0);
  });

  it("prefers stronger overlap", () => {
    const r = classifyTweet(
      mk("Trump met Xi in Beijing about chips. Nvidia exports discussed."),
      { topics, fallbackTopic: "other" },
    );
    expect(["us_china", "ai_chip"]).toContain(r.topic);
  });
});
