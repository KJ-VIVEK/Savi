import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
];
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

interface ClientConfig { client_id: string; client_secret: string }
interface Tokens { access: string; refresh: string; expires: number }
interface TokenReply {
  access_token: string; refresh_token?: string; expires_in: number; scope?: string;
  error?: string; error_description?: string;
}

const CLIENT = "google.client";
const TOKENS = "google.tokens";

export class NotConnectedError extends Error {}

/** Parses the JSON file Google offers when you create a Desktop app client. */
export function parseClientFile(json: string): ClientConfig {
  let parsed: { installed?: Partial<ClientConfig> } | null;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  const c = parsed?.installed;
  if (!c?.client_id || !c.client_secret)
    throw new Error("Choose the JSON of an OAuth client of type 'Desktop app'.");
  return { client_id: c.client_id, client_secret: c.client_secret };
}

/** OAuth for an installed app: system browser, loopback redirect, PKCE. */
export class GoogleAuth {
  private secrets: SecretStore;
  private fetcher: typeof fetch;
  private refreshing?: Promise<string>;

  constructor(secrets: SecretStore, fetcher: typeof fetch = fetch) {
    this.secrets = secrets;
    this.fetcher = fetcher;
  }

  async hasClient() { return (await this.secrets.get(CLIENT)) !== undefined; }
  async isConnected() { return (await this.secrets.get(TOKENS)) !== undefined; }
  async setClient(c: ClientConfig) { await this.secrets.store(CLIENT, JSON.stringify(c)); }

  async connect(openBrowser: (url: string) => PromiseLike<unknown>, signal: AbortSignal): Promise<void> {
    const client = await this.client();
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(16).toString("base64url");
    const { code, redirect } = await this.authorize(client, verifier, state, openBrowser, signal);
    const reply = await this.token({
      client_id: client.client_id, client_secret: client.client_secret,
      code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirect,
    });
    const granted = new Set(reply.scope?.split(" ") ?? []);
    if (!SCOPES.every((s) => granted.has(s)))
      throw new Error("Savi needs both Calendar and Tasks access. Connect again and tick both boxes.");
    if (!reply.refresh_token) throw new Error("Google did not return a refresh token. Connect again.");
    await this.save(reply, reply.refresh_token);
  }

  /** Revokes the grant at Google, then forgets it. The client file is kept. */
  async disconnect(): Promise<void> {
    const tokens = await this.tokens();
    await this.secrets.delete(TOKENS);
    if (!tokens) return;
    const res = await this.fetcher("https://oauth2.googleapis.com/revoke", {
      method: "POST", body: new URLSearchParams({ token: tokens.refresh }),
    });
    if (!res.ok) throw new Error("Signed out here, but Google could not revoke access. Remove it at myaccount.google.com/permissions.");
  }

  async accessToken(forceRefresh = false): Promise<string> {
    const tokens = await this.tokens();
    if (!tokens) throw new NotConnectedError("Google is not connected. Run 'Savi: Connect Google'.");
    if (!forceRefresh && tokens.expires > Date.now() + 60_000) return tokens.access;
    // Parallel requests share one refresh.
    this.refreshing ??= this.refresh(tokens.refresh).finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async refresh(refresh: string): Promise<string> {
    const client = await this.client();
    const reply = await this.token({
      client_id: client.client_id, client_secret: client.client_secret,
      refresh_token: refresh, grant_type: "refresh_token",
    });
    // Do not resurrect a session that was disconnected meanwhile.
    if ((await this.tokens())?.refresh === refresh) await this.save(reply, reply.refresh_token ?? refresh);
    return reply.access_token;
  }

  private async token(params: Record<string, string>): Promise<TokenReply> {
    const res = await this.fetcher(TOKEN_URL, {
      method: "POST", body: new URLSearchParams(params), signal: AbortSignal.timeout(30_000),
    });
    const reply = (await res.json()) as TokenReply;
    if (res.ok) return reply;
    if (reply.error === "invalid_grant" && params.grant_type === "refresh_token") {
      await this.secrets.delete(TOKENS);
      throw new NotConnectedError("Google sign-in expired. Run 'Savi: Connect Google'.");
    }
    throw new Error(`Google sign-in failed: ${reply.error_description ?? reply.error ?? res.status}`);
  }

  private async authorize(
    client: ClientConfig, verifier: string, state: string,
    openBrowser: (url: string) => PromiseLike<unknown>, signal: AbortSignal,
  ): Promise<{ code: string; redirect: string }> {
    const server = createServer();
    try {
      await new Promise<void>((ok, no) => {
        server.once("error", no);
        server.listen(0, "127.0.0.1", ok);
      });
      const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const result = new Promise<string>((ok, no) => {
        const abort = () => no(new Error("Google sign-in was cancelled or timed out."));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        server.on("request", (req, res) => {
          const q = new URL(req.url ?? "/", redirect).searchParams;
          // Ignore anything that does not carry our state (favicons, other local processes).
          if (!same(q.get("state") ?? "", state)) return void res.writeHead(404, { connection: "close" }).end();
          const code = q.get("code");
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8", connection: "close" });
          res.end(code ? "Savi is connected. You can close this tab." : "Sign-in was not completed. You can close this tab.");
          if (code) ok(code);
          else no(new Error(`Google sign-in failed: ${q.get("error") ?? "no code returned"}`));
        });
      });
      result.catch(() => {}); // awaited below; avoids an unhandled rejection while the browser opens
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: client.client_id, redirect_uri: redirect, response_type: "code", scope: SCOPES.join(" "),
        state, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256", access_type: "offline", prompt: "consent",
      }).toString();
      await openBrowser(url.toString());
      return { code: await result, redirect };
    } finally {
      server.close();
    }
  }

  private async client(): Promise<ClientConfig> {
    const raw = await this.secrets.get(CLIENT);
    if (!raw) throw new NotConnectedError("Google is not set up. Run 'Savi: Connect Google'.");
    return JSON.parse(raw);
  }

  private async tokens(): Promise<Tokens | undefined> {
    const raw = await this.secrets.get(TOKENS);
    return raw ? JSON.parse(raw) : undefined;
  }

  private async save(reply: TokenReply, refresh: string) {
    const tokens: Tokens = { access: reply.access_token, refresh, expires: Date.now() + reply.expires_in * 1000 };
    await this.secrets.store(TOKENS, JSON.stringify(tokens));
  }
}

function same(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
