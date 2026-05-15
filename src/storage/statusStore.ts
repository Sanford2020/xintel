import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { RunStatus } from "../types/index.js";
import { nowIso } from "../utils/time.js";

export class StatusStore {
  public readonly path: string;
  private state: RunStatus;

  constructor(filePath: string, initial: RunStatus) {
    this.path = resolve(filePath);
    mkdirSync(dirname(this.path), { recursive: true });
    this.state = initial;
    this.persist();
  }

  static load(filePath: string): RunStatus | null {
    const abs = resolve(filePath);
    if (!existsSync(abs)) return null;
    try {
      return JSON.parse(readFileSync(abs, "utf8")) as RunStatus;
    } catch {
      return null;
    }
  }

  get(): RunStatus {
    return this.state;
  }

  update(patch: Partial<RunStatus>): void {
    this.state = { ...this.state, ...patch, updatedAt: nowIso() };
    this.persist();
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify(this.state, null, 2), "utf8");
  }
}
