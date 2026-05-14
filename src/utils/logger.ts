import pino, { type Logger } from "pino";
import { mkdirSync, createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";

export interface LoggerOptions {
  level?: string;
  prettyPrint?: boolean;
  logFile?: string;
  errFile?: string;
}

let cached: Logger | null = null;

export function createLogger(opts: LoggerOptions = {}): Logger {
  if (cached) return cached;

  const level = opts.level ?? process.env.LOG_LEVEL ?? "info";

  const streams: pino.StreamEntry[] = [];

  if (opts.prettyPrint !== false) {
    const pretty = pino.transport({
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:standard" },
    });
    streams.push({ stream: pretty, level: level as pino.Level });
  } else {
    streams.push({ stream: process.stdout, level: level as pino.Level });
  }

  if (opts.logFile) {
    const filePath = resolve(opts.logFile);
    mkdirSync(dirname(filePath), { recursive: true });
    streams.push({
      stream: createWriteStream(filePath, { flags: "a" }),
      level: "debug",
    });
  }

  if (opts.errFile) {
    const filePath = resolve(opts.errFile);
    mkdirSync(dirname(filePath), { recursive: true });
    streams.push({
      stream: createWriteStream(filePath, { flags: "a" }),
      level: "error",
    });
  }

  cached = pino(
    { level, base: { app: "xintel" }, timestamp: pino.stdTimeFunctions.isoTime },
    pino.multistream(streams),
  );
  return cached;
}

export function getLogger(): Logger {
  if (!cached) return createLogger();
  return cached;
}
