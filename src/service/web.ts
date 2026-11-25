import { readFileSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { certificateFor } from "./certificate.ts";
import type { DeviceStore, Pairing } from "./pairing.ts";
import type { Event } from "./protocol.ts";

const PORT = 8787;
const CERT_PORT = 8788;
const MAX_BODY = 64_000;
const COOKIE = "__Host-savi";

const FILES: Record<string, [file: string, type: string]> = {
  "/": ["app/index.html", "text/html; charset=utf-8"],
  "/app.js": ["app/app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app/app.css", "text/css; charset=utf-8"],
  "/markdown.js": ["markdown.js", "text/javascript; charset=utf-8"],
  "/chat.js": ["chat.js", "text/javascript; charset=utf-8"],
  "/chat.css": ["chat.css", "text/css; charset=utf-8"],
  "/icon.svg": ["app/icon.svg", "image/svg+xml"],
  "/manifest.webmanifest": ["app/manifest.webmanifest", "application/manifest+json"],
};

const HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
};

export interface WebOptions {
  dir: string;
  media: string;
  pairing: Pairing;
  devices: DeviceStore;
  /** Runs a method a phone may call; throws for any other. */
  call: (method: string, params: unknown) => Promise<unknown>;
  state: () => Event;
  ports?: { https: number; http: number };
}

/** The address on the private network, if it is up. */
export function addressOn(name: string): string | undefined {
  return networkInterfaces()[name]?.find((a) => a.family === "IPv4")?.address;
}

/** Serves the phone app on one private address only. */
export class Web {
  private options: WebOptions;
  private servers: Server[] = [];
  private streams = new Map<ServerResponse, number>();
  private ca = "";
  private updating?: Promise<void>;
  ip?: string;

  constructor(options: WebOptions) { this.options = options; }

  get ports() { return this.options.ports ?? { https: PORT, http: CERT_PORT }; }
  get origin() { return `https://${this.ip}:${this.ports.https}`; }
  get certificateUrl() { return `http://${this.ip}:${this.ports.http}/`; }

  /** Follows the address: starts, moves or stops. Calls never overlap. */
  update(ip: string | undefined): Promise<void> {
    const next = (this.updating ?? Promise.resolve()).catch(() => {}).then(() => this.apply(ip));
    this.updating = next;
    return next;
  }

  private async apply(ip: string | undefined) {
    if (ip === this.ip) return;
    this.close();
    if (!ip) return;
    const { ca, cert, key } = await certificateFor(ip, this.options.dir);
    this.ca = ca;
    const https = createHttps({ cert, key, minVersion: "TLSv1.2" }, (q, s) => void this.handle(q, s));
    const http = createHttp((q, s) => this.certificate(q, s));
    this.servers = [https, http];
    try {
      await listen(https, this.ports.https, ip);
      await listen(http, this.ports.http, ip);
      this.ip = ip;
    } catch (e) {
      this.close();
      throw e;
    }
  }

  close() {
    for (const s of this.streams.keys()) s.end();
    this.streams.clear();
    for (const s of this.servers) {
      s.close();
      s.closeAllConnections();
    }
    this.servers = [];
    this.ip = undefined;
  }

  emit(e: Event) { for (const s of this.streams.keys()) send(s, e); }

  /** Cuts off a device that was removed. */
  drop(device: number) {
    for (const [s, d] of this.streams) if (d === device) s.end();
  }

  /** Plain HTTP, because the phone cannot trust us before this. Open only while pairing. */
  private certificate(req: IncomingMessage, res: ServerResponse) {
    if (!this.options.pairing.isOpen() || req.method !== "GET") return reply(res, 404, "Not found");
    if (req.url === "/savi.crt") {
      res.writeHead(200, { ...HEADERS, "content-type": "application/x-x509-ca-cert", "content-disposition": 'attachment; filename="savi.crt"' });
      return void res.end(this.ca);
    }
    if (req.url !== "/") return reply(res, 404, "Not found");
    res.writeHead(200, { ...HEADERS, "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Savi setup</title>
<h1>Savi setup</h1><ol><li><a href="/savi.crt">Download the certificate</a></li>
<li>In Android Settings, search for "CA certificate", choose Install anyway, and pick savi.crt</li>
<li><a href="${this.origin}/">Open Savi</a> and enter the code shown in VS Code</li></ol></html>`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      // Refuses other names pointed at this address, and requests made by other sites.
      if (req.headers.host !== `${this.ip}:${this.ports.https}`) return reply(res, 421, "Wrong host");
      const path = (req.url ?? "/").split("?")[0]!;
      if (req.method === "GET" && Object.hasOwn(FILES, path)) {
        const [file, type] = FILES[path]!;
        res.writeHead(200, { ...HEADERS, "content-type": type });
        return void res.end(readFileSync(join(this.options.media, file)));
      }
      if (req.method === "POST" && req.headers.origin !== this.origin) return reply(res, 403, "Wrong origin");
      if (req.method === "POST" && path === "/pair") return await this.pair(req, res);

      const device = this.options.pairing.device(cookie(req));
      if (device === undefined) return reply(res, 401, "Not paired");
      if (req.method === "GET" && path === "/paired") return json(res, 200, {});
      if (req.method === "GET" && path === "/events") return this.stream(req, res, device);
      if (req.method === "POST" && path === "/call") {
        const { method, params } = (await body(req)) as { method: string; params: unknown };
        const answer = await this.options.call(String(method), params ?? {}).then(
          (result) => ({ result }),
          (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }),
        );
        return json(res, 200, answer);
      }
      reply(res, 404, "Not found");
    } catch {
      if (!res.headersSent) reply(res, 400, "Bad request");
      else res.end();
    }
  }

  private async pair(req: IncomingMessage, res: ServerResponse) {
    const { code } = (await body(req)) as { code?: unknown };
    const name = /Android/.test(req.headers["user-agent"] ?? "") ? "Android phone" : "Browser";
    const token = this.options.pairing.redeem(String(code ?? ""), name);
    if (!token) return json(res, 403, { error: "That code is wrong or has expired. Get a new one in VS Code." });
    res.setHeader("set-cookie", `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=34560000`);
    json(res, 200, {});
  }

  private stream(req: IncomingMessage, res: ServerResponse, device: number) {
    this.options.devices.seenDevice(device);
    const mine = [...this.streams].filter(([, d]) => d === device);
    if (mine.length >= 5) mine[0]![0].end();
    res.writeHead(200, { ...HEADERS, "content-type": "text/event-stream" });
    // The full state first, so a phone that was away catches up.
    send(res, this.options.state());
    this.streams.set(res, device);
    const beat = setInterval(() => res.write(":\n\n"), 25_000);
    res.on("close", () => {
      clearInterval(beat);
      this.streams.delete(res);
    });
  }
}

const listen = (s: Server, port: number, ip: string) =>
  new Promise<void>((ok, no) => {
    s.once("error", no);
    s.listen(port, ip, () => {
      s.off("error", no);
      s.on("error", () => {});
      ok();
    });
  });

const send = (res: ServerResponse, e: Event) => void res.write(`data: ${JSON.stringify(e)}\n\n`);

function reply(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { ...HEADERS, "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { ...HEADERS, "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function cookie(req: IncomingMessage) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === COOKIE) return v;
  }
}

async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    if ((size += c.length) > MAX_BODY) throw new Error("Too large");
    chunks.push(c);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof value !== "object" || value === null) throw new Error("Bad request");
  return value;
}
