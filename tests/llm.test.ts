import { describe, expect, it } from "vitest";
import { buildLlmAdapter } from "../src/integrations/llm.js";

describe("LLM adapter (BYOK fallback)", () => {
  it("returns a disabled adapter when llm.enabled=false", () => {
    const a = buildLlmAdapter({
      enabled: false,
      provider: "anthropic",
      model: "x",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      maxOutputTokens: 100,
      temperature: 0.2,
      timeoutMs: 1000,
      maxCallsPerSummary: 1,
    });
    expect(a.enabled).toBe(false);
    expect(a.isExhausted()).toBe(true);
  });

  it("returns disabled when API key env var is missing", () => {
    delete process.env.NEVER_SET_KEY_FOR_TEST;
    const a = buildLlmAdapter({
      enabled: true,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      apiKeyEnv: "NEVER_SET_KEY_FOR_TEST",
      maxOutputTokens: 100,
      temperature: 0.2,
      timeoutMs: 1000,
      maxCallsPerSummary: 1,
    });
    expect(a.enabled).toBe(false);
  });

  it("returns disabled for provider=none", () => {
    const a = buildLlmAdapter({
      enabled: true,
      provider: "none",
      model: "x",
      apiKeyEnv: "X",
      maxOutputTokens: 100,
      temperature: 0.2,
      timeoutMs: 1000,
      maxCallsPerSummary: 1,
    });
    expect(a.enabled).toBe(false);
  });
});
