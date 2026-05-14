import type { Page } from "playwright-core";
import { sleep } from "../utils/time.js";

/**
 * Read-only scroll: just dispatches PageDown / mouse-wheel-equivalent scrolls.
 * Does not click, focus, or otherwise interact with content.
 */
export async function gentleScroll(
  page: Page,
  batches: number,
  delayMs: number,
  signal?: AbortSignal,
): Promise<number> {
  let done = 0;
  for (let i = 0; i < batches; i++) {
    if (signal?.aborted) break;
    try {
      await page.evaluate(`(() => {
        window.scrollBy(0, Math.max(400, Math.floor(window.innerHeight * 0.9)));
      })()`);
    } catch {
      break;
    }
    done += 1;
    try {
      await sleep(delayMs, signal);
    } catch {
      break;
    }
  }
  return done;
}
