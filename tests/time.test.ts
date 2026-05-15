import { describe, expect, it } from "vitest";
import { parseDuration } from "../src/utils/time.js";

describe("parseDuration", () => {
  it("parses ms / s / m / h", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  it("accepts raw numbers as milliseconds", () => {
    expect(parseDuration(1234)).toBe(1234);
  });

  it("rejects nonsense", () => {
    expect(() => parseDuration("hello")).toThrow();
  });
});
