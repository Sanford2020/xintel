import lockfile from "proper-lockfile";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type ReleaseLock = () => Promise<void>;

export async function acquireSingleInstanceLock(
  lockPath: string,
): Promise<ReleaseLock> {
  const abs = resolve(lockPath);
  mkdirSync(dirname(abs), { recursive: true });
  if (!existsSync(abs)) writeFileSync(abs, "", "utf8");
  try {
    const release = await lockfile.lock(abs, {
      retries: { retries: 0 },
      stale: 60_000,
    });
    return async () => {
      try {
        await release();
      } catch {
        // ignore
      }
    };
  } catch (err) {
    throw new Error(
      `Another xintel process appears to be running (lock: ${abs}). ` +
        `If you are sure no instance is running, remove the lock file. (${(err as Error).message})`,
    );
  }
}
