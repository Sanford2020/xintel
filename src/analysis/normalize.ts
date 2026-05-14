import type { TweetRecord } from "../types/index.js";

const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const T_CO = /\bt\.co\/\S+/gi;

export function normalizeText(text: string): string {
  return (text || "")
    .replace(ZERO_WIDTH, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeForHash(text: string): string {
  return normalizeText(text)
    .replace(URL_RE, " ")
    .replace(T_CO, " ")
    .replace(/[#@][\w\u4e00-\u9fff]+/g, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeTweets(tweets: TweetRecord[]): TweetRecord[] {
  return tweets.map((t) => ({
    ...t,
    textNorm: normalizeText(t.textRaw ?? t.textNorm ?? ""),
  }));
}
