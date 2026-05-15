import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAggregate,
  compareDays,
  findPreviousAggregate,
  readAggregate,
  writeAggregate,
} from "../src/storage/dayAggregates.js";

describe("dayAggregates", () => {
  it("writes and reads back an aggregate", () => {
    const dir = mkdtempSync(join(tmpdir(), "xintel-agg-"));
    try {
      const agg = buildAggregate({
        pack: "ai-watcher",
        date: "2024-06-01",
        raw: 10,
        deduped: 8,
        perTopic: { openai: 3, anthropic: 5 },
        perSource: { search: 8 },
        highFrequency: [{ phrase: "openai|@u", count: 4 }],
        rumorCount: 1,
        noiseCount: 0,
      });
      writeAggregate(dir, agg);
      const back = readAggregate(dir, "2024-06-01", "ai-watcher");
      expect(back?.raw).toBe(10);
      expect(back?.perTopic.openai).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("findPreviousAggregate returns nearest prior date", () => {
    const dir = mkdtempSync(join(tmpdir(), "xintel-agg-"));
    try {
      writeAggregate(dir, buildAggregate({ pack: "p", date: "2024-06-01", raw: 1, deduped: 1, perTopic: {}, perSource: {}, highFrequency: [], rumorCount: 0, noiseCount: 0 }));
      writeAggregate(dir, buildAggregate({ pack: "p", date: "2024-06-03", raw: 1, deduped: 1, perTopic: {}, perSource: {}, highFrequency: [], rumorCount: 0, noiseCount: 0 }));
      const prev = findPreviousAggregate(dir, "2024-06-05", "p");
      expect(prev?.date).toBe("2024-06-03");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compareDays computes deltas and new topics", () => {
    const today = buildAggregate({
      pack: "p", date: "2024-06-02",
      raw: 10, deduped: 8,
      perTopic: { openai: 10, anthropic: 3, newtopic: 5 },
      perSource: {}, highFrequency: [], rumorCount: 0, noiseCount: 0,
    });
    const yesterday = buildAggregate({
      pack: "p", date: "2024-06-01",
      raw: 5, deduped: 4,
      perTopic: { openai: 5, anthropic: 6 },
      perSource: {}, highFrequency: [], rumorCount: 0, noiseCount: 0,
    });
    const cmp = compareDays(today, yesterday);
    expect(cmp).not.toBeNull();
    expect(cmp!.previousDate).toBe("2024-06-01");
    expect(cmp!.newToday).toContain("newtopic");
    const openai = cmp!.deltas.find((d) => d.topic === "openai");
    expect(openai?.diff).toBe(5);
  });

  it("compareDays returns empty result when no previous", () => {
    const today = buildAggregate({ pack: "p", date: "2024-06-02", raw: 1, deduped: 1, perTopic: {}, perSource: {}, highFrequency: [], rumorCount: 0, noiseCount: 0 });
    const cmp = compareDays(today, null);
    expect(cmp.previousDate).toBe("");
    expect(cmp.deltas).toEqual([]);
  });
});
