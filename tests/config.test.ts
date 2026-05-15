import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";

describe("config", () => {
  it("loads default.json", () => {
    const { config, hash, sources } = loadConfig();
    expect(config.browser.port).toBe(9224);
    expect(config.classify.topics.ai_agent?.label).toBeDefined();
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(sources.length).toBeGreaterThanOrEqual(1);
  });
});
