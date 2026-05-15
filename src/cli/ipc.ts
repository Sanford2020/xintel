import { createServer, type Server, type Socket, createConnection } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { getLogger } from "../utils/logger.js";

export type IpcCommand = "pause" | "resume" | "stop" | "status";

export interface IpcRequest {
  cmd: IpcCommand;
}

export interface IpcResponse {
  ok: boolean;
  error?: string;
  data?: unknown;
}

export interface IpcHandlers {
  onPause: () => Promise<IpcResponse> | IpcResponse;
  onResume: () => Promise<IpcResponse> | IpcResponse;
  onStop: () => Promise<IpcResponse> | IpcResponse;
  onStatus: () => Promise<IpcResponse> | IpcResponse;
}

export class IpcServer {
  private server: Server | null = null;
  constructor(public readonly socketPath: string, private handlers: IpcHandlers) {}

  async start(): Promise<void> {
    const abs = resolve(this.socketPath);
    mkdirSync(dirname(abs), { recursive: true });

    if (process.platform === "win32") {
      // On Windows, use a named pipe path.
      // Node supports \\.\pipe\xxx style listening.
    } else if (existsSync(abs)) {
      try { unlinkSync(abs); } catch { /* ignore */ }
    }
    const log = getLogger();
    this.server = createServer((sock: Socket) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk;
        const idx = buf.indexOf("\n");
        if (idx === -1) return;
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        let req: IpcRequest;
        try {
          req = JSON.parse(line) as IpcRequest;
        } catch (err) {
          sock.write(JSON.stringify({ ok: false, error: (err as Error).message }) + "\n");
          sock.end();
          return;
        }
        const handlePromise = (() => {
          switch (req.cmd) {
            case "pause": return Promise.resolve(this.handlers.onPause());
            case "resume": return Promise.resolve(this.handlers.onResume());
            case "stop": return Promise.resolve(this.handlers.onStop());
            case "status": return Promise.resolve(this.handlers.onStatus());
            default: return Promise.resolve({ ok: false, error: `unknown cmd: ${(req as IpcRequest).cmd}` } satisfies IpcResponse);
          }
        })();
        handlePromise
          .then((resp) => {
            sock.write(JSON.stringify(resp) + "\n");
            sock.end();
          })
          .catch((err: Error) => {
            sock.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
            sock.end();
          });
      });
      sock.on("error", (err) => log.debug({ err: err.message }, "ipc socket error"));
    });
    await new Promise<void>((res, rej) => {
      this.server!.once("error", rej);
      this.server!.listen(abs, () => {
        this.server!.off("error", rej);
        res();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((res) => this.server!.close(() => res()));
    this.server = null;
    const abs = resolve(this.socketPath);
    if (process.platform !== "win32" && existsSync(abs)) {
      try { unlinkSync(abs); } catch { /* ignore */ }
    }
  }
}

export async function sendIpc(
  socketPath: string,
  req: IpcRequest,
  timeoutMs = 3000,
): Promise<IpcResponse> {
  const abs = resolve(socketPath);
  return new Promise<IpcResponse>((res, rej) => {
    if (process.platform !== "win32" && !existsSync(abs)) {
      rej(new Error(`No running xintel detected (socket missing: ${abs}).`));
      return;
    }
    const sock = createConnection(abs);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      rej(new Error(`IPC timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    sock.on("connect", () => {
      sock.write(JSON.stringify(req) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        clearTimeout(timer);
        const line = buf.slice(0, idx).trim();
        try {
          res(JSON.parse(line) as IpcResponse);
        } catch (err) {
          rej(err as Error);
        }
        sock.end();
      }
    });
    sock.on("error", (err: Error) => {
      clearTimeout(timer);
      rej(err);
    });
  });
}
