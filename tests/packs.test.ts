import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { resolvePacks, discoverPacks, primaryPack, applyPacks } from "../src/config/packs.js";
import { ConfigSchema } from "../src/config/schema.js";

const PROJECT_ROOT = resolve(__dirname, "..");

describe("packs loader", () => {
  it("discovers all built-in packs", () => {
    const found = discoverPacks(PROJECT_ROOT, ["config/packs"]);
    const names = found.map((p) => p.pack.name).sort();
    expect(names).toEqual(["ai-watcher", "crypto-trader", "finance-media"]);
  });

  it("resolves enabled packs by name and reports missing ones", () => {
    const r = resolvePacks(PROJECT_ROOT, ["ai-watcher", "does-not-exist"], ["config/packs"]);
    expect(r.packs).toHaveLength(1);
    expect(r.packs[0]!.pack.name).toBe("ai-watcher");
    expect(r.missing).toContain("does-not-exist");
  });

  it("merges pack topics into base config additively", () => {
    const cfg = ConfigSchema.parse({
      browser: {},
      schedule: {},
      sources: { for_you: {}, following: {}, explore: {}, trends: {}, lists: {}, search: { queries: [] } },
      classify: { topics: { existing: { label: "Existing", keywords: ["foo"] } }, fallbackTopic: "other" },
      dedupe: {},
      notion: {},
      logging: {},
      paths: {},
    });
    const r = resolvePacks(PROJECT_ROOT, ["ai-watcher"], ["config/packs"]);
    const merged = applyPacks(cfg, r.packs);
    expect(merged.classify.topics.existing).toBeDefined();
    expect(merged.classify.topics.openai).toBeDefined();
    expect(primaryPack(r.packs)?.name).toBe("ai-watcher");
  });
});
