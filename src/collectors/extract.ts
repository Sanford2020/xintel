import type { Page } from "playwright-core";

/**
 * In-page extraction logic. Runs inside the browser, has no Node access.
 *
 * Read-only: only reads DOM text, links, and aria-labels of already rendered
 * tweet articles. Does not click, hover-interact, or modify anything.
 */
export const TWEET_EXTRACTOR_SCRIPT = /* js */ `
(() => {
  function normalizeWs(s) {
    return (s || "").replace(/\\s+/g, " ").trim();
  }
  function parseMetric(label, kind) {
    if (!label) return undefined;
    const re = new RegExp(\`([0-9][0-9,\\\\.]*)\\\\s*[Kk]?[Mm]?\\\\s*\${kind}\`, "i");
    const m = label.match(re);
    if (!m) return undefined;
    let n = m[1].replace(/,/g, "");
    let mult = 1;
    if (/k$/i.test(label.slice(m.index + m[0].length - 1, m.index + m[0].length))) mult = 1_000;
    if (/m$/i.test(label.slice(m.index + m[0].length - 1, m.index + m[0].length))) mult = 1_000_000;
    const v = Math.round(parseFloat(n) * mult);
    return Number.isFinite(v) ? v : undefined;
  }
  function pickMetric(el, testId) {
    const node = el.querySelector('[data-testid="' + testId + '"]');
    if (!node) return undefined;
    const aria = node.getAttribute("aria-label") || node.textContent || "";
    const num = aria.replace(/[^0-9KMkm.,]/g, "");
    if (!num) return undefined;
    let mult = 1;
    if (/[Kk]$/.test(num)) mult = 1_000;
    if (/[Mm]$/.test(num)) mult = 1_000_000;
    const v = Math.round(parseFloat(num.replace(/[KMkm,]/g, "")) * mult);
    return Number.isFinite(v) ? v : undefined;
  }

  const out = [];
  const seen = new Set();
  const articles = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
  for (const a of articles) {
    try {
      const permalinkAnchor = a.querySelector('a[href*="/status/"][role="link"]');
      const permalink = permalinkAnchor ? permalinkAnchor.getAttribute("href") : null;
      const idMatch = permalink ? permalink.match(/\\/status\\/(\\d+)/) : null;
      const id = idMatch ? idMatch[1] : undefined;
      const dedupeKey = id || (permalink || "") + (a.textContent || "").slice(0, 80);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const userBlock = a.querySelector('[data-testid="User-Name"]');
      let author, handle;
      if (userBlock) {
        const spans = userBlock.querySelectorAll("span");
        for (const sp of spans) {
          const t = sp.textContent || "";
          if (!handle && /^@\\w+$/.test(t.trim())) handle = t.trim();
          else if (!author && t.trim() && !t.includes("@") && !/^·$/.test(t.trim())) {
            author = t.trim();
          }
        }
      }

      const textEl = a.querySelector('[data-testid="tweetText"]');
      const textRaw = textEl ? normalizeWs(textEl.textContent || "") : normalizeWs(a.textContent || "").slice(0, 1200);

      const lang = textEl ? textEl.getAttribute("lang") || undefined : undefined;

      const timeEl = a.querySelector("time");
      const postedAt = timeEl ? timeEl.getAttribute("datetime") || undefined : undefined;

      const hasMedia =
        !!a.querySelector('[data-testid="tweetPhoto"]') ||
        !!a.querySelector('[data-testid="videoPlayer"]') ||
        !!a.querySelector('div[aria-label*="Image" i]');

      const isRepost = !!a.querySelector('[data-testid="socialContext"]');

      const links = Array.from(a.querySelectorAll('a[href]'))
        .map((x) => x.getAttribute("href"))
        .filter((h) => !!h && /^https?:\\/\\//.test(h));
      const hashtags = (textRaw.match(/#[A-Za-z0-9_\\u4e00-\\u9fff]+/g) || []).map((s) => s.toLowerCase());
      const mentions = (textRaw.match(/@\\w+/g) || []).map((s) => s.toLowerCase());

      const metrics = {
        reply: pickMetric(a, "reply"),
        retweet: pickMetric(a, "retweet"),
        like: pickMetric(a, "like"),
      };
      const viewsAnchor = a.querySelector('a[href*="/analytics"]');
      if (viewsAnchor) {
        const aria = viewsAnchor.getAttribute("aria-label") || viewsAnchor.textContent || "";
        const v = parseMetric(aria, "view");
        if (v !== undefined) metrics.view = v;
      }

      // quoted tweet
      let quoted;
      const quotedEl = a.querySelector('div[role="link"][tabindex="0"]');
      if (quotedEl && quotedEl !== a) {
        const qTextEl = quotedEl.querySelector('[data-testid="tweetText"]');
        const qText = qTextEl ? normalizeWs(qTextEl.textContent || "") : "";
        const qHandleEl = quotedEl.querySelector('[data-testid="User-Name"]');
        let qAuthor, qHandle;
        if (qHandleEl) {
          const spans = qHandleEl.querySelectorAll("span");
          for (const sp of spans) {
            const t = (sp.textContent || "").trim();
            if (!qHandle && /^@\\w+$/.test(t)) qHandle = t;
            else if (!qAuthor && t && !t.includes("@")) qAuthor = t;
          }
        }
        if (qText) quoted = { author: qAuthor, handle: qHandle, textNorm: qText };
      }

      if (!textRaw && !id) continue;

      out.push({
        id,
        permalink: permalink ? new URL(permalink, location.origin).toString() : undefined,
        author,
        handle,
        textRaw,
        lang,
        postedAt,
        metrics,
        hasMedia,
        isRepost,
        links,
        hashtags,
        mentions,
        quoted,
      });
    } catch (e) {
      // skip individual article failures
    }
  }
  return out;
})();
`;

export const TREND_EXTRACTOR_SCRIPT = /* js */ `
(() => {
  function normalizeWs(s) { return (s || "").replace(/\\s+/g, " ").trim(); }
  const out = [];
  const items = document.querySelectorAll('[data-testid="trend"]');
  let rank = 0;
  for (const it of items) {
    try {
      const spans = it.querySelectorAll("span");
      let topic = "", category = "", postsCount = "";
      const texts = Array.from(spans).map((s) => normalizeWs(s.textContent || "")).filter(Boolean);
      if (texts.length === 0) continue;
      for (const t of texts) {
        if (!category && /·\\s*Trending/i.test(t)) category = t;
        if (!postsCount && /posts?$/i.test(t)) postsCount = t;
      }
      topic = texts.find((t) => t !== category && !/posts?$/i.test(t) && t !== "·") || texts[0];
      if (!topic) continue;
      rank += 1;
      out.push({
        rank,
        topic,
        category: category || undefined,
        postsCount: postsCount || undefined,
      });
    } catch (_) {}
  }
  return out;
})();
`;

export const RAW_LINES_SCRIPT = /* js */ `
(() => {
  const lines = [];
  const main = document.querySelector('main[role="main"]') || document.body;
  const text = (main.innerText || "").split(/\\n+/).map((s) => s.trim()).filter(Boolean);
  for (const l of text) {
    if (lines.length >= 200) break;
    if (l.length >= 2 && l.length <= 400) lines.push(l);
  }
  return lines;
})();
`;

export interface RawTweetExtract {
  id?: string;
  permalink?: string;
  author?: string;
  handle?: string;
  textRaw: string;
  lang?: string;
  postedAt?: string;
  metrics?: { reply?: number; retweet?: number; like?: number; view?: number };
  hasMedia: boolean;
  isRepost: boolean;
  links: string[];
  hashtags: string[];
  mentions: string[];
  quoted?: { author?: string; handle?: string; textNorm: string };
}

export interface RawTrendExtract {
  rank: number;
  topic: string;
  category?: string;
  postsCount?: string;
}

export async function extractTweets(page: Page): Promise<RawTweetExtract[]> {
  return (await page.evaluate(TWEET_EXTRACTOR_SCRIPT)) as RawTweetExtract[];
}

export async function extractTrends(page: Page): Promise<RawTrendExtract[]> {
  return (await page.evaluate(TREND_EXTRACTOR_SCRIPT)) as RawTrendExtract[];
}

export async function extractRawLines(page: Page): Promise<string[]> {
  return (await page.evaluate(RAW_LINES_SCRIPT)) as string[];
}
