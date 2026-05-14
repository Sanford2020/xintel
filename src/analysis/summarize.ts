import type {
  ClassifiedTweet,
  RoundRecord,
  Summary,
  TweetRecord,
} from "../types/index.js";
import type { AppConfig } from "../config/schema.js";
import { classifyAll } from "./classify.js";
import { dedupe } from "./dedupe.js";
import { normalizeTweets } from "./normalize.js";

const RUMOR_HINTS = [
  "rumor", "rumour", "据传", "传闻", "据说", "据报道", "internal source",
  "leak", "leaked", "源自", "据知情人士",
];
const NOISE_HINTS = [
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

function detectRumors(tweets: ClassifiedTweet[]) {
  const out: { text: string; reason: string }[] = [];
  for (const t of tweets) {
    const text = (t.textNorm ?? "").toLowerCase();
    const hit = RUMOR_HINTS.find((h) => text.includes(h));
    if (hit) {
      out.push({
        text: t.textNorm.slice(0, 200),
        reason: `命中传闻关键词: ${hit}`,
      });
    }
  }
  return out.slice(0, 40);
}

function detectNoise(tweets: ClassifiedTweet[]): number {
  let n = 0;
  for (const t of tweets) {
    const text = (t.textNorm ?? "").toLowerCase();
    if (NOISE_HINTS.some((h) => text.includes(h))) n += 1;
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
}

export interface SummarizeOutput {
  summary: Summary;
  markdown: string;
}

export function summarize(input: SummarizeInput): SummarizeOutput {
  const { rounds, config } = input;

  const allTweets: TweetRecord[] = [];
  for (const r of rounds) {
    for (const p of r.pages) {
      for (const t of p.tweets) allTweets.push(t);
    }
  }
  const normalized = normalizeTweets(allTweets);
  const { unique, stat } = dedupe(normalized, config.dedupe);
  const classified = classifyAll(unique, {
    topics: config.classify.topics,
    fallbackTopic: config.classify.fallbackTopic,
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
    rumors: detectRumors(classified),
    noise: detectNoise(classified),
    followUps: followUps(classified),
    appendix: { samples: classified.slice(0, 50) },
  };

  return { summary, markdown: renderMarkdown(summary, config) };
}

function fmtTweet(t: ClassifiedTweet): string {
  const who = t.handle ? `${t.author ?? ""} (${t.handle})` : t.author ?? "匿名";
  const link = t.permalink ? ` ${t.permalink}` : "";
  const text = (t.textNorm || t.textRaw || "").replace(/\n/g, " ").trim().slice(0, 280);
  return `- ${who}: ${text}${link}`;
}

export function renderMarkdown(summary: Summary, config: AppConfig): string {
  const lines: string[] = [];
  lines.push(`# X 情报采集简报`);
  lines.push("");
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
  lines.push(`> ⚠ 以下内容来自 X.com 公开页面，**包含 X 上流传但未核验的说法**，请勿直接当作事实采用。AI 的判断与原始信息已区分标注。`);
  lines.push("");

  lines.push(`## 关键判断（AI 推断）`);
  if (summary.followUps.length === 0) {
    lines.push(`- 暂无足以构成判断的高密度信号。`);
  } else {
    for (const f of summary.followUps) lines.push(`- ${f}`);
  }
  lines.push("");

  lines.push(`## 主题分析`);
  for (const [key, items] of Object.entries(summary.topics)) {
    if (key === "noise") continue;
    const label = items[0]?.topicLabel ?? key;
    lines.push(`### ${label} (${items.length})`);
    for (const t of items.slice(0, 8)) lines.push(fmtTweet(t));
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

  lines.push(`## 新增信号 (AI 推断)`);
  if (summary.newSignals.length === 0) lines.push(`- 暂无明确新增信号。`);
  for (const s of summary.newSignals.slice(0, 15)) lines.push(`- ${s}`);
  lines.push("");

  lines.push(`## 需要核验的传言 (未核实)`);
  if (summary.rumors.length === 0) lines.push(`- 本轮未检测到典型传言关键词。`);
  for (const r of summary.rumors.slice(0, 20)) {
    lines.push(`- ${r.text} _(${r.reason})_`);
  }
  lines.push("");

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

  lines.push(`## 数据附录（最多 50 条原始样本）`);
  for (const t of summary.appendix.samples) {
    lines.push(fmtTweet(t));
  }
  lines.push("");

  void config; // currently unused; reserved for future LLM prompting
  return lines.join("\n");
}
