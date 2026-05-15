import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RoundRecord } from "../types/index.js";

export class JsonlStore {
  private stream: WriteStream;
  public readonly path: string;

  constructor(filePath: string) {
    this.path = resolve(filePath);
    mkdirSync(dirname(this.path), { recursive: true });
    this.stream = createWriteStream(this.path, { flags: "a", encoding: "utf8" });
  }

  appendRound(round: RoundRecord): Promise<void> {
    return new Promise((res, rej) => {
      this.stream.write(JSON.stringify(round) + "\n", (err) => {
        if (err) rej(err);
        else res();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((res) => {
      this.stream.end(() => res());
    });
  }
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(filePath, "utf8");
  const out: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // skip malformed line
    }
  }
  return out;
}
