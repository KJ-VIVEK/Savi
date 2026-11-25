import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { dataDir, socketPath } from "../service/paths.ts";
import { type Config, type Event, Lines, type Methods, type Reply } from "../service/protocol.ts";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Talks to the Savi service, starting or replacing it when needed. */
export class Client {
  private socket?: Socket;
  private opening?: Promise<Socket>;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;
  private options: { script: string; build: string; config: () => Config; onEvent: (e: Event) => void; onOpen: () => void };

  constructor(options: Client["options"]) { this.options = options; }

  async call<M extends keyof Methods>(method: M, params: Parameters<Methods[M]>[0]): Promise<ReturnType<Methods[M]>> {
    return this.request(await this.open(), method, params);
  }

  /** Sends settings to a service that is already connected. */
  async configure() { await this.call("hello", { config: this.options.config() }); }

  dispose() {
    this.disposed = true;
    this.socket?.destroy();
  }

  private open(): Promise<Socket> {
    if (this.disposed) return Promise.reject(new Error("Savi is closed."));
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    return (this.opening ??= this.start().finally(() => (this.opening = undefined)));
  }

  private async start(): Promise<Socket> {
    let replaced = false;
    let spawned = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const socket = await dial().catch(() => undefined);
      if (!socket) {
        // Again after a while, in case an old service was still shutting down.
        if (!spawned || attempt % 20 === 0) this.spawn();
        spawned = true;
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      this.attach(socket);
      const { build } = await this.request(socket, "hello", { config: this.options.config() });
      if (build !== this.options.build && !replaced) {
        replaced = true; // left over from another version of the extension
        await this.request(socket, "shutdown", {}).catch(() => {});
        socket.destroy();
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      this.socket = socket;
      this.options.onOpen();
      return socket;
    }
    throw new Error(`The Savi service did not start. See ${join(dataDir(), "service.log")}.`);
  }

  /** VS Code's own runtime as plain Node, detached so it outlives the window. */
  private spawn() {
    const log = openSync(join(dataDir(), "service.log"), "w", 0o600);
    const child = spawn(process.execPath, [this.options.script], {
      detached: true, stdio: ["ignore", log, log], cwd: dataDir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.on("error", () => {});
    child.unref();
    closeSync(log);
  }

  private attach(socket: Socket) {
    const lines = new Lines();
    socket.setEncoding("utf8");
    socket.on("data", (data) => {
      try {
        for (const m of lines.push(String(data)) as (Reply | Event)[]) {
          if ("event" in m) {
            // Nothing is shown from a service that is about to be replaced.
            if (this.socket === socket) this.options.onEvent(m);
            continue;
          }
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error !== undefined) p?.reject(new Error(m.error));
          else p?.resolve(m.result);
        }
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("Lost connection to the Savi service."));
      this.pending.clear();
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.disposed) setTimeout(() => void this.open().catch(() => {}), 1000);
    });
  }

  private request<M extends keyof Methods>(socket: Socket, method: M, params: Parameters<Methods[M]>[0]) {
    return new Promise<ReturnType<Methods[M]>>((resolve, reject) => {
      if (socket.destroyed) return reject(new Error("Lost connection to the Savi service."));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
}

function dial() {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect(socketPath());
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}
