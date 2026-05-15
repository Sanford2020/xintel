import type { AppConfig } from "../config/schema.js";
import type { ClassifiedTweet, TweetRecord } from "../types/index.js";

export interface ClassifyOptions {
  topics: AppConfig["classify"]["topics"];
  fallbackTopic: string;
}

export function classifyTweet(
  tw: TweetRecord,
  opts: ClassifyOptions,
): ClassifiedTweet {
  const haystack = (tw.textNorm ?? tw.textRaw ?? "").toLowerCase();
  let bestKey = opts.fallbackTopic;
  let bestScore = 0;
  let bestLabel = "其他 / 低信号";

  for (const [key, def] of Object.entries(opts.topics)) {
    let score = 0;
    for (const kw of def.keywords) {
      const needle = kw.toLowerCase();
      if (!needle) continue;
      if (haystack.includes(needle)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
      bestLabel = def.label;
    }
  }

  if (bestScore === 0) {
    bestKey = opts.fallbackTopic;
    bestLabel = "其他 / 低信号";
  }

  return { ...tw, topic: bestKey, topicLabel: bestLabel, topicScore: bestScore };
}

export function classifyAll(
  tweets: TweetRecord[],
  opts: ClassifyOptions,
): ClassifiedTweet[] {
  return tweets.map((t) => classifyTweet(t, opts));
}
