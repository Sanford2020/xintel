import { describe, expect, it } from "vitest";
import { normalizeText, normalizeForHash } from "../src/analysis/normalize.js";

describe("normalize", () => {
  it("collapses whitespace and zero-width chars", () => {
    expect(normalizeText("  hello\u200b   world \n!")).toBe("hello world !");
  });

  it("strips urls/handles/hashtags for hashing", () => {
    const out = normalizeForHash("Check https://t.co/abc #ai @openai cool stuff!");
    expect(out).toBe("check cool stuff");
  });
});
