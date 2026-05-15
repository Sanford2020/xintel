import type { BrowserContext, Page } from "playwright-core";
import type { AppConfig } from "../config/schema.js";
import type {
  PageRecord,
  PageType,
  TweetRecord,
  TrendRecord,
} from "../types/index.js";
import { nowIso, sleep } from "../utils/time.js";
import {
  extractTweets,
  extractTrends,
  extractRawLines,
  type RawTweetExtract,
} from "./extract.js";
import { gentleScroll } from "./scroll.js";
import { getLogger } from "../utils/logger.js";

export interface CollectTarget {
  type: PageType;
  name: string;
  url: string;
  /**
   * Optional X-side tab to click via URL only (e.g. ?f=live for search).
   * No DOM clicks involved.
   */
  finalQuery?: string;
}

export interface CollectorOptions {
  round: number;
  signal?: AbortSignal;
}

function normalizeTweet(
  raw: RawTweetExtract,
  source: { pageType: PageType; pageName: string; round: number },
): TweetRecord {
  const textRaw = raw.textRaw ?? "";
  const textNorm = textRaw
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    id: raw.id,
    permalink: raw.permalink,
    author: raw.author,
    handle: raw.handle,
    textRaw,
    textNorm,
    lang: raw.lang,
    postedAt: raw.postedAt,
    capturedAt: nowIso(),
    metrics: raw.metrics,
    hasMedia: !!raw.hasMedia,
    isRepost: !!raw.isRepost,
    quoted: raw.quoted,
    links: raw.links ?? [],
    hashtags: raw.hashtags ?? [],
    mentions: raw.mentions ?? [],
    source,
  };
}

function normalizeTrend(raw: {
  rank: number;
  topic: string;
  category?: string;
  postsCount?: string;
}): TrendRecord {
  return { ...raw, capturedAt: nowIso() };
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const pages = context.pages();
  if (pages.length > 0) return pages[0]!;
  return context.newPage();
}

/**
 * Click-free tab switching: We try to find the For You / Following tab using
 * an accessibility query; if not visible, we just fall back to the URL.
 *
 * Why this is still read-only safe:
 *   X exposes these as <a role="tab" href="/home"> elements which are pure
 *   navigation, not state-changing. We treat them as link navigation, never
 *   pressing any post/like/follow/reply controls.
 *
 * If the user's UI does not show the tab, we silently skip switching.
 */
async function switchHomeTab(page: Page, tab: "for_you" | "following"): Promise<void> {
  const label = tab === "for_you" ? "For you" : "Following";
  try {
    const candidate = page.getByRole("tab", { name: label, exact: false }).first();
    if (await candidate.count()) {
      // Use href if available, otherwise skip — never simulate a click on
      // anything that could be a state-changing control.
      const href = await candidate.getAttribute("href").catch(() => null);
      if (href) {
        const url = new URL(href, "https://x.com").toString();
        await page.goto(url, { waitUntil: "domcontentloaded" });
      }
    }
  } catch {
    // ignore, fallback to whatever tab loads on /home
  }
}

async function collectFeedPage(
  context: BrowserContext,
  cfg: AppConfig,
  target: CollectTarget,
  opts: CollectorOptions,
): Promise<PageRecord> {
  const log = getLogger();
  const page = await getOrCreatePage(context);
  const started = nowIso();
  const startMs = Date.now();
  log.info({ target }, "Collecting page");

  try {
    await page.goto(target.url, {
      waitUntil: "domcontentloaded",
      timeout: cfg.schedule.perPageTimeoutMs,
    });
    if (target.type === "for_you") await switchHomeTab(page, "for_you");
    if (target.type === "following") await switchHomeTab(page, "following");

    if (target.finalQuery) {
      const sep = target.url.includes("?") ? "&" : "?";
      await page.goto(target.url + sep + target.finalQuery, {
        waitUntil: "domcontentloaded",
        timeout: cfg.schedule.perPageTimeoutMs,
      });
    }

    // wait briefly for first articles
    try {
      await page.waitForSelector('article[data-testid="tweet"], article[role="article"]', {
        timeout: 8000,
      });
    } catch {
      // proceed; may be empty feed / login wall
    }

    const batches = await gentleScroll(
      page,
      cfg.schedule.perPageScrollBatches,
      cfg.schedule.scrollDelayMs,
      opts.signal,
    );
    // small grace period for last batch to render
    await sleep(500).catch(() => undefined);

    const finalUrl = page.url();
    const title = await page.title().catch(() => "");

    const rawTweets = await extractTweets(page);
    const tweets = rawTweets.map((t) =>
      normalizeTweet(t, {
        pageType: target.type,
        pageName: target.name,
        round: opts.round,
      }),
    );
    const lines = await extractRawLines(page);

    return {
      type: target.type,
      name: target.name,
      url: target.url,
      finalUrl,
      title,
      startedAt: started,
      finishedAt: nowIso(),
      batches,
      tweets,
      lines,
    };
  } catch (err) {
    const e = err as Error;
    log.error({ err: e.message, target }, "Page collection failed");
    return {
      type: target.type,
      name: target.name,
      url: target.url,
      finalUrl: page.url?.() ?? target.url,
      title: "",
      startedAt: started,
      finishedAt: nowIso(),
      batches: 0,
      tweets: [],
      error: {
        message: e.message,
        stack: e.stack,
        recoverable: !/closed|disconnected/i.test(e.message),
      },
    };
  } finally {
    const ms = Date.now() - startMs;
    log.debug({ ms, target }, "Page done");
  }
}

async function collectTrendsPage(
  context: BrowserContext,
  cfg: AppConfig,
  target: CollectTarget,
  opts: CollectorOptions,
): Promise<PageRecord> {
  const log = getLogger();
  const page = await getOrCreatePage(context);
  const started = nowIso();
  try {
    await page.goto(target.url, {
      waitUntil: "domcontentloaded",
      timeout: cfg.schedule.perPageTimeoutMs,
    });
    try {
      await page.waitForSelector('[data-testid="trend"]', { timeout: 8000 });
    } catch {
      // proceed even if no trends rendered
    }
    const batches = await gentleScroll(
      page,
      Math.min(2, cfg.schedule.perPageScrollBatches),
      cfg.schedule.scrollDelayMs,
      opts.signal,
    );
    const rawTrends = await extractTrends(page);
    const trends = rawTrends.map(normalizeTrend);
    const lines = await extractRawLines(page);
    return {
      type: target.type,
      name: target.name,
      url: target.url,
      finalUrl: page.url(),
      title: await page.title().catch(() => ""),
      startedAt: started,
      finishedAt: nowIso(),
      batches,
      tweets: [],
      trends,
      lines,
    };
  } catch (err) {
    const e = err as Error;
    log.error({ err: e.message, target }, "Trends collection failed");
    return {
      type: target.type,
      name: target.name,
      url: target.url,
      finalUrl: page.url?.() ?? target.url,
      title: "",
      startedAt: started,
      finishedAt: nowIso(),
      batches: 0,
      tweets: [],
      trends: [],
      error: {
        message: e.message,
        stack: e.stack,
        recoverable: !/closed|disconnected/i.test(e.message),
      },
    };
  }
}

export function buildTargets(cfg: AppConfig): CollectTarget[] {
  const t: CollectTarget[] = [];
  if (cfg.sources.for_you.enabled) {
    t.push({ type: "for_you", name: "For You", url: cfg.sources.for_you.url });
  }
  if (cfg.sources.following.enabled) {
    t.push({ type: "following", name: "Following", url: cfg.sources.following.url });
  }
  if (cfg.sources.explore.enabled) {
    t.push({ type: "explore", name: "Explore", url: cfg.sources.explore.url });
  }
  if (cfg.sources.trends.enabled) {
    t.push({ type: "trends", name: "Trends", url: cfg.sources.trends.url });
  }
  if (cfg.sources.lists.enabled) {
    for (const li of cfg.sources.lists.items) {
      t.push({ type: "list", name: `List: ${li.name}`, url: li.url });
    }
  }
  if (cfg.sources.search.enabled) {
    for (const q of cfg.sources.search.queries) {
      const url = `https://x.com/search?q=${encodeURIComponent(q.q)}&src=typed_query${q.live ? "&f=live" : ""}`;
      t.push({ type: "search", name: `Search: ${q.name}`, url });
    }
  }
  return t;
}

export async function collectOnce(
  context: BrowserContext,
  cfg: AppConfig,
  targets: CollectTarget[],
  opts: CollectorOptions,
): Promise<PageRecord[]> {
  const pages: PageRecord[] = [];
  for (const target of targets) {
    if (opts.signal?.aborted) break;
    const page =
      target.type === "trends"
        ? await collectTrendsPage(context, cfg, target, opts)
        : await collectFeedPage(context, cfg, target, opts);
    pages.push(page);
  }
  return pages;
}
