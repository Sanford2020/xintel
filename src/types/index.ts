export type PageType =
  | "for_you"
  | "following"
  | "explore"
  | "trends"
  | "list"
  | "search";

export interface TweetMetrics {
  reply?: number;
  retweet?: number;
  like?: number;
  view?: number;
}

export interface QuotedTweet {
  author?: string;
  handle?: string;
  textNorm: string;
}

export interface TweetSource {
  pageType: PageType;
  pageName: string;
  round: number;
}

export interface TweetRecord {
  id?: string;
  permalink?: string;
  author?: string;
  handle?: string;
  textRaw: string;
  textNorm: string;
  lang?: string;
  postedAt?: string;
  capturedAt: string;
  metrics?: TweetMetrics;
  hasMedia: boolean;
  isRepost: boolean;
  quoted?: QuotedTweet;
  links: string[];
  hashtags: string[];
  mentions: string[];
  source: TweetSource;
}

export interface TrendRecord {
  rank: number;
  topic: string;
  category?: string;
  postsCount?: string;
  capturedAt: string;
}

export interface PageError {
  message: string;
  stack?: string;
  recoverable: boolean;
}

export interface PageRecord {
  type: PageType;
  name: string;
  url: string;
  finalUrl: string;
  title: string;
  startedAt: string;
  finishedAt: string;
  batches: number;
  tweets: TweetRecord[];
  trends?: TrendRecord[];
  lines?: string[];
  error?: PageError;
}

export interface RoundMeta {
  appVersion: string;
  configHash: string;
  browserEndpoint: string;
}

export interface RoundRecord {
  round: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  pages: PageRecord[];
  meta: RoundMeta;
}

export type RunState =
  | "idle"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "error";

export interface RunStatus {
  pid: number;
  state: RunState;
  startedAt: string;
  updatedAt: string;
  currentRound: number;
  totalRounds: number;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  currentOutputFile: string;
  runId: string;
  browser: {
    connected: boolean;
    endpoint?: string;
    lastPingAt?: string;
  };
}

export type TopicKey = string;

export interface TopicDefinition {
  label: string;
  keywords: string[];
}

export interface ClassifiedTweet extends TweetRecord {
  topic: TopicKey;
  topicLabel: string;
  topicScore: number;
}

export interface Summary {
  runId: string;
  windowStart: string;
  windowEnd: string;
  raw: number;
  deduped: number;
  duplicationRate: number;
  perSource: Record<string, number>;
  perTopic: Record<TopicKey, number>;
  topics: Record<TopicKey, ClassifiedTweet[]>;
  highFrequency: { phrase: string; count: number }[];
  newSignals: string[];
  rumors: { text: string; reason: string }[];
  noise: number;
  followUps: string[];
  appendix: { samples: ClassifiedTweet[] };
}
