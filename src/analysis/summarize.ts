import type {
  ClassifiedTweet,
  RoundRecord,
  Summary,
  TweetRecord,
} from "../types/index.js";
import type { AppConfig, SegmentPack } from "../config/schema.js";
import { classifyAll } from "./classify.js";
import { dedupe } from "./dedupe.js";
import { normalizeTweets } from "./normalize.js";
import type { LlmAdapter } from "../integrations/llm.js";
import type {
  AggregateComparison,
  DailyAggregate,
} from "../storage/dayAggregates.js";

const BUILT_IN_RUMOR_HINTS = [
  "rumor", "rumour", "据传", "传闻", "据说", "据报道", "internal source",
  "leak", "leaked", "源自", "据知情人士",
];
const BUILT_IN_NOISE_HINTS = [
  "giveaway", "airdrop", "follow back", "f4f", "buy now",
  "promo", "限时", "薅羊毛", "白嫖",
];

function topPhrases(tweets: TweetRecord[], min = 2, limit = 30) {
  const counts = new Map<string, number>();
  for (const t of tweets) {
    const text = (t.textNorm ?? t.textRaw ?? "").toLowerCase();
    const tokens = text
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^\p{L}\p{N}#@_\u4e00-\u9fff\s]/gu, " ")
      .split(/\s+/)
      .filter((x) => x.length >= 2 && x.length <= 40);
    const seen = new Set<string>();
    for (let i = 0; i < tokens.length - 1; i++) {
      const bigram = `${tokens[i]} ${tokens[i + 1]}`;
      if (seen.has(bigram)) continue;
      seen.add(bigram);
      counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
    }
    for (const tok of tokens) {
      if (tok.startsWith("#") || tok.startsWith("@")) {
        counts.set(tok, (counts.get(tok) ?? 0) + 1);
      }
    }
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c >= min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([phrase, count]) => ({ phrase, count }));
}

function inferNewSignals(tweets: ClassifiedTweet[]): string[] {
  const out: string[] = [];
  const byKey = new Map<string, ClassifiedTweet[]>();
  for (const t of tweets) {
    const handle = (t.handle ?? "anon").toLowerCase();
    const key = `${t.topic}::${handle}`;
    const arr = byKey.get(key) ?? [];
    arr.push(t);
    byKey.set(key, arr);
  }
  for (const [key, arr] of byKey.entries()) {
    if (arr.length >= 2) {
      const [topic, handle] = key.split("::");
      const sample = arr[0]!.textNorm.slice(0, 120);
      out.push(`【${topic}】${handle} 反复提及: ${sample}…`);
    }
  }
  return out.slice(0, 30);
}

function detectRumors(tweets: ClassifiedTweet[], hints: string[]) {
  const out: { text: string; reason: string }[] = [];
  for (const t of tweets) {
    const text = (t.textNorm ?? "").toLowerCase();
    const hit = hints.find((h) => text.includes(h.toLowerCase()));
    if (hit) {
      out.push({
        text: t.textNorm.slice(0, 200),
        reason: `命中传闻关键词: ${hit}`,
      });
    }
  }
  return out.slice(0, 40);
}

function detectNoise(tweets: ClassifiedTweet[], hints: string[]): number {
  let n = 0;
  for (const t of tweets) {
    const text = (t.textNorm ?? "").toLowerCase();
    if (hints.some((h) => text.includes(h.toLowerCase()))) n += 1;
  }
  return n;
}

function followUps(tweets: ClassifiedTweet[]): string[] {
  const followUps: string[] = [];
  const byTopic = new Map<string, ClassifiedTweet[]>();
  for (const t of tweets) {
    const arr = byTopic.get(t.topic) ?? [];
    arr.push(t);
    byTopic.set(t.topic, arr);
  }
  for (const [topic, arr] of byTopic.entries()) {
    if (topic === "noise" || topic === "other") continue;
    if (arr.length >= 3) {
      followUps.push(`继续跟踪「${arr[0]!.topicLabel}」: 已有 ${arr.length} 条独立观察`);
    }
  }
  return followUps;
}

export interface SummarizeInput {
  runId: string;
  rounds: RoundRecord[];
  config: AppConfig;
  /** Active pack for tone/template/LLM prompt (null => fall back to defaults). */
  pack?: SegmentPack | null;
  /** Optional LLM adapter. If disabled, briefing skips LLM section. */
  llm?: LlmAdapter | null;
  /** Cross-day comparison (optional). */
  comparison?: AggregateComparison | null;
}

export interface SummarizeOutput {
  summary: Summary;
  markdown: string;
  /** True if LLM was actually used to produce the "AI 综述" section. */
  llmUsed: boolean;
  /** Daily aggregate suitable for storing on disk for cross-day comparison. */
  aggregate: Pick<
    DailyAggregate,
    "raw" | "deduped" | "perTopic" | "perSource" | "highFrequency" | "rumorCount" | "noiseCount"
  >;
}

function fmtTweet(t: ClassifiedTweet): string {
  const who = t.handle ? `${t.author ?? ""} (${t.handle})` : t.author ?? "匿名";
  const link = t.permalink ? ` ${t.permalink}` : "";
  const text = (t.textNorm || t.textRaw || "").replace(/\n/g, " ").trim().slice(0, 280);
  return `- ${who}: ${text}${link}`;
}

function buildTopicDump(
  summary: Summary,
  maxSamplesPerTopic: number,
): string {
  const blocks: string[] = [];
  for (const [topic, items] of Object.entries(summary.topics)) {
    if (topic === "noise") continue;
    if (items.length === 0) continue;
    const label = items[0]?.topicLabel ?? topic;
    blocks.push(`### ${label} (${items.length}, key=${topic})`);
    for (const t of items.slice(0, maxSamplesPerTopic)) {
      blocks.push(fmtTweet(t));
    }
    blocks.push("");
  }
  return blocks.join("\n");
}

function buildPrevCountsBlock(comparison: AggregateComparison | null | undefined): string {
  if (!comparison || !comparison.previousDate) return "(no previous-day data)";
  const lines: string[] = [];
  lines.push(`previous day = ${comparison.previousDate}`);
  for (const d of comparison.deltas) {
    if (d.todayCount === 0 && d.yesterdayCount === 0) continue;
    lines.push(`- ${d.topic}: ${d.yesterdayCount} → ${d.todayCount} (Δ ${d.diff >= 0 ? "+" : ""}${d.diff})`);
  }
  if (comparison.newToday.length > 0) {
    lines.push(`new topics today: ${comparison.newToday.join(", ")}`);
  }
  return lines.join("\n");
}

export async function summarize(input: SummarizeInput): Promise<SummarizeOutput> {
  const { rounds, config, pack, llm, comparison } = input;

  const allTweets: TweetRecord[] = [];
  for (const r of rounds) {
    for (const p of r.pages) {
      for (const t of p.tweets) allTweets.push(t);
    }
  }
  const normalized = normalizeTweets(allTweets);
  const { unique, stat } = dedupe(normalized, config.dedupe);

  const topicsForClassify =
    pack && Object.keys(pack.topics).length > 0
      ? pack.topics
      : config.classify.topics;
  const fallbackTopic = pack?.fallbackTopic ?? config.classify.fallbackTopic;

  const classified = classifyAll(unique, {
    topics: topicsForClassify,
    fallbackTopic,
  });

  const perSource: Record<string, number> = {};
  for (const t of classified) {
    const k = t.source?.pageName ?? "unknown";
    perSource[k] = (perSource[k] ?? 0) + 1;
  }

  const perTopic: Record<string, number> = {};
  const topics: Record<string, ClassifiedTweet[]> = {};
  for (const t of classified) {
    perTopic[t.topic] = (perTopic[t.topic] ?? 0) + 1;
    if (!topics[t.topic]) topics[t.topic] = [];
    topics[t.topic]!.push(t);
  }

  const rumorHints =
    pack && pack.rumorHints.length > 0 ? pack.rumorHints : BUILT_IN_RUMOR_HINTS;
  const noiseHints =
    pack && pack.noiseHints.length > 0 ? pack.noiseHints : BUILT_IN_NOISE_HINTS;

  const summary: Summary = {
    runId: input.runId,
    windowStart: rounds[0]?.startedAt ?? "",
    windowEnd: rounds[rounds.length - 1]?.finishedAt ?? "",
    raw: stat.raw,
    deduped: stat.deduped,
    duplicationRate: stat.duplicationRate,
    perSource,
    perTopic,
    topics,
    highFrequency: topPhrases(classified, 2, 30),
    newSignals: inferNewSignals(classified),
    rumors: detectRumors(classified, rumorHints),
    noise: detectNoise(classified, noiseHints),
    followUps: followUps(classified),
    appendix: { samples: classified.slice(0, 50) },
  };

  let llmSection = "";
  let llmUsed = false;
  if (llm && llm.enabled && !llm.isExhausted() && classified.length > 0) {
    const pkTemplate = pack?.reportTemplate;
    const systemPrompt = pack?.llmSystemPrompt?.trim()
      ? pack.llmSystemPrompt
      : "You are a careful intelligence analyst. Mark each finding with [FACT], [INFER], or [RUMOR]. Output Markdown.";
    const userTemplate = pack?.llmUserPromptTemplate?.trim()
      ? pack.llmUserPromptTemplate
      : "Topic dump:\n{{topicDump}}\n\nProduce a Markdown briefing.";
    const topicDump = buildTopicDump(
      summary,
      pkTemplate?.maxSamplesPerTopic ?? 8,
    );
    const previousDayCounts = buildPrevCountsBlock(comparison);
    const userPrompt = userTemplate
      .replace(/\{\{topicDump\}\}/g, topicDump)
      .replace(/\{\{previousDayCounts\}\}/g, previousDayCounts)
      .replace(
        /\{\{maxSamplesPerTopic\}\}/g,
        String(pkTemplate?.maxSamplesPerTopic ?? 8),
      );
    const res = await llm.call({ systemPrompt, userPrompt });
    if (res && res.text) {
      llmSection = res.text;
      llmUsed = true;
    }
  }

  const markdown = renderMarkdown(summary, config, {
    pack,
    llmSection,
    comparison,
  });

  return {
    summary,
    markdown,
    llmUsed,
    aggregate: {
      raw: stat.raw,
      deduped: stat.deduped,
      perTopic,
      perSource,
      highFrequency: summary.highFrequency,
      rumorCount: summary.rumors.length,
      noiseCount: summary.noise,
    },
  };
}

export interface RenderOptions {
  pack?: SegmentPack | null;
  llmSection?: string;
  comparison?: AggregateComparison | null;
}

export function renderMarkdown(
  summary: Summary,
  config: AppConfig,
  opts: RenderOptions = {},
): string {
  const { pack, llmSection, comparison } = opts;
  const template = pack?.reportTemplate;
  const title = template?.title ?? "X 情报采集简报";
  const introNote =
    template?.introNote ??
    "以下内容来自 X.com 公开页面，**包含 X 上流传但未核验的说法**，请勿直接当作事实采用。AI 的判断与原始信息已区分标注。";

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  if (pack) {
    lines.push(`> **客户群 (Pack)**: \`${pack.name}\` — ${pack.description}`);
  }
  lines.push(
    `**采集窗口**: \`${summary.windowStart}\` → \`${summary.windowEnd}\``,
  );
  lines.push(`**Run ID**: \`${summary.runId}\``);
  lines.push("");
  lines.push(`## 摘要`);
  lines.push(
    `本轮采集到 ${summary.raw} 条样本，去重后 ${summary.deduped} 条，重复率 ${(summary.duplicationRate * 100).toFixed(1)}%。覆盖来源 ${
      Object.keys(summary.perSource).length
    } 个，主题 ${Object.keys(summary.perTopic).length} 类。`,
  );
  lines.push("");
  lines.push(`> ⚠ ${introNote}`);
  lines.push("");

  if (llmSection && llmSection.trim().length > 0) {
    lines.push(`## AI 综述 (LLM 推断)`);
    lines.push(llmSection.trim());
    lines.push("");
  }

  lines.push(`## 关键判断 (规则推断)`);
  if (summary.followUps.length === 0) {
    lines.push(`- 暂无足以构成判断的高密度信号。`);
  } else {
    for (const f of summary.followUps) lines.push(`- ${f}`);
  }
  lines.push("");

  if (comparison && comparison.previousDate) {
    lines.push(`## 昨日对比 (跨日趋势)`);
    lines.push(`比对日期: ${comparison.previousDate} → ${comparison.date}`);
    const movers = comparison.deltas
      .filter((d) => d.todayCount > 0 || d.yesterdayCount > 0)
      .slice(0, 12);
    if (movers.length === 0) {
      lines.push(`- 暂无可比较的主题（首次运行该 pack）。`);
    } else {
      for (const d of movers) {
        const arrow = d.diff > 0 ? "↑" : d.diff < 0 ? "↓" : "·";
        const pctStr = isFinite(d.pct) ? `${d.pct.toFixed(0)}%` : "(new)";
        lines.push(
          `- ${arrow} \`${d.topic}\`: ${d.yesterdayCount} → ${d.todayCount} (${pctStr})`,
        );
      }
    }
    if (comparison.newToday.length > 0) {
      lines.push("");
      lines.push(`**今日新出现的主题**: ${comparison.newToday.map((t) => `\`${t}\``).join(", ")}`);
    }
    lines.push("");
  }

  const maxSamples = template?.maxSamplesPerTopic ?? 8;
  lines.push(`## 主题分析`);
  for (const [key, items] of Object.entries(summary.topics)) {
    if (key === "noise") continue;
    const label = items[0]?.topicLabel ?? key;
    lines.push(`### ${label} (${items.length})`);
    for (const t of items.slice(0, maxSamples)) lines.push(fmtTweet(t));
    lines.push("");
  }

  lines.push(`## 高频信号`);
  if (summary.highFrequency.length === 0) {
    lines.push(`- 无显著高频组合。`);
  } else {
    for (const h of summary.highFrequency.slice(0, 20)) {
      lines.push(`- \`${h.phrase}\` × ${h.count}`);
    }
  }
  lines.push("");

  lines.push(`## 新增信号 (规则推断)`);
  if (summary.newSignals.length === 0) lines.push(`- 暂无明确新增信号。`);
  for (const s of summary.newSignals.slice(0, 15)) lines.push(`- ${s}`);
  lines.push("");

  if (template?.includeRumors !== false) {
    lines.push(`## 需要核验的传言 (未核实)`);
    if (summary.rumors.length === 0) lines.push(`- 本轮未检测到典型传言关键词。`);
    for (const r of summary.rumors.slice(0, 20)) {
      lines.push(`- ${r.text} _(${r.reason})_`);
    }
    lines.push("");
  }

  lines.push(`## 噪声与风险`);
  lines.push(`- 命中营销/低价值噪声: ${summary.noise} 条`);
  lines.push(`- 各来源命中数:`);
  for (const [src, n] of Object.entries(summary.perSource)) {
    lines.push(`  - ${src}: ${n}`);
  }
  lines.push("");

  lines.push(`## 后续跟踪清单`);
  if (summary.followUps.length === 0) {
    lines.push(`- 暂无。`);
  } else {
    for (const f of summary.followUps) lines.push(`- ${f}`);
  }
  lines.push("");

  if (template?.includeAppendix !== false) {
    lines.push(`## 数据附录（最多 50 条原始样本）`);
    for (const t of summary.appendix.samples) {
      lines.push(fmtTweet(t));
    }
    lines.push("");
  }

  void config;
  return lines.join("\n");
}
