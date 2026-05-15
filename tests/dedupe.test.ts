import { describe, expect, it } from "vitest";
import { dedupe } from "../src/analysis/dedupe.js";
import type { TweetRecord } from "../src/types/index.js";

function mk(id: string, text: string, handle = "@u"): TweetRecord {
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
    source: { pageType: "for_you", pageName: "For You", round: 1 },
  };
}

describe("dedupe", () => {
  it("drops exact id duplicates", () => {
    const a = mk("1", "OpenAI ships GPT-5 with multimodal reasoning");
    const b = mk("1", "OpenAI ships GPT-5 with multimodal reasoning");
    const { unique, stat } = dedupe([a, b], {
      minTextLength: 8,
      shingleSize: 6,
      similarityThreshold: 0.85,
    });
    expect(unique.length).toBe(1);
    expect(stat.raw).toBe(2);
  });

  it("drops near-duplicates by shingle similarity", () => {
    const a = mk("1", "Nvidia stock crashed today after China export ban news lol omg");
    const b = mk("2", "NVIDIA stock crashed today after China export ban news lol omg ");
    const c = mk("3", "Tencent invests in Moonshot AI lab in Beijing today");
    const { unique } = dedupe([a, b, c], {
      minTextLength: 8,
      shingleSize: 4,
      similarityThreshold: 0.7,
    });
    expect(unique.length).toBe(2);
  });

  it("keeps very short distinct tweets even when similar punctuation", () => {
    const a = mk("1", "ok");
    const b = mk("2", "ok!");
    const { unique } = dedupe([a, b], {
      minTextLength: 8,
      shingleSize: 4,
      similarityThreshold: 0.85,
    });
    expect(unique.length).toBe(2);
  });
});
