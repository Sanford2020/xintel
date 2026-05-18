import { z } from "zod";
import type { LlmAdapter } from "../integrations/llm.js";
import { getLogger } from "../utils/logger.js";

export const SignalSchema = z.object({
  topic: z.string(),
  headline: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  category: z.enum(["fact", "inference", "rumor"]),
  source: z.string().optional(),
  relevance: z.number().min(0).max(10),
  actionable: z.boolean(),
  suggestedAction: z.string().optional(),
});

export const StructuredBriefingSchema = z.object({
  signals: z.array(SignalSchema),
  marketMood: z.enum(["bullish", "bearish", "neutral", "mixed"]).optional(),
  topTrends: z.array(z.string()).max(10),
  risks: z.array(z.string()).max(5),
  opportunities: z.array(z.string()).max(5),
  summary: z.string(),
  followUpQuestions: z.array(z.string()).max(5),
});

export type Signal = z.infer<typeof SignalSchema>;
export type StructuredBriefing = z.infer<typeof StructuredBriefingSchema>;

const STRUCTURED_SYSTEM_PROMPT = `You are an intelligence analyst. Analyze the provided tweet data and output ONLY valid JSON matching the exact schema below. No markdown, no explanation — just the JSON object.

Schema:
{
  "signals": [{ "topic": string, "headline": string, "confidence": "high"|"medium"|"low", "category": "fact"|"inference"|"rumor", "source": string?, "relevance": 0-10, "actionable": boolean, "suggestedAction": string? }],
  "marketMood": "bullish"|"bearish"|"neutral"|"mixed",
  "topTrends": [string, max 10],
  "risks": [string, max 5],
  "opportunities": [string, max 5],
  "summary": string,
  "followUpQuestions": [string, max 5]
}

Rules:
- Each signal must be tagged with confidence and category
- relevance: 0 = noise, 10 = critical
- actionable signals MUST have suggestedAction
- summary should be 2-3 sentences max
- Output valid JSON only`;

export async function generateStructuredBriefing(
  llm: LlmAdapter,
  topicDump: string,
): Promise<StructuredBriefing | null> {
  const log = getLogger();
  if (!llm.enabled || llm.isExhausted()) return null;

  const result = await llm.call({
    systemPrompt: STRUCTURED_SYSTEM_PROMPT,
    userPrompt: `Analyze these tweets and produce structured JSON:\n\n${topicDump}`,
    temperature: 0.1,
  });

  if (!result?.text) return null;

  let jsonText = result.text.trim();
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonText = fenceMatch[1]?.trim() ?? jsonText;
  }

  try {
    const parsed: unknown = JSON.parse(jsonText);
    const validated = StructuredBriefingSchema.parse(parsed);
    log.info(
      { signalCount: validated.signals.length, mood: validated.marketMood },
      "Structured briefing generated",
    );
    return validated;
  } catch (err) {
    log.warn(
      { err: (err as Error).message, raw: jsonText.slice(0, 200) },
      "Failed to parse structured LLM output, falling back",
    );
    return null;
  }
}

export function filterActionableSignals(
  briefing: StructuredBriefing,
  minRelevance = 7,
): Signal[] {
  return briefing.signals.filter(
    (s) => s.actionable && s.relevance >= minRelevance,
  );
}

export function formatSignalsForHuman(signals: Signal[]): string {
  if (signals.length === 0) return "No actionable signals detected.";
  const lines: string[] = ["*Actionable Signals:*"];
  for (const s of signals) {
    const icon = s.confidence === "high" ? "\u{1F534}" : s.confidence === "medium" ? "\u{1F7E1}" : "\u{26AA}";
    lines.push(`${icon} [${s.category.toUpperCase()}] ${s.headline}`);
    if (s.suggestedAction) lines.push(`   Action: ${s.suggestedAction}`);
    lines.push(`   Topic: ${s.topic} | Relevance: ${s.relevance}/10`);
    lines.push("");
  }
  return lines.join("\n");
}
