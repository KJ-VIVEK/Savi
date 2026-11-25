import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Agent, type Assistant } from "../core/agent.ts";
import type { LLM } from "../core/llm.ts";
import { addDays, parseLocal, toDate } from "../core/time.ts";
import type { Tool } from "../core/tools.ts";
import { AnthropicLLM } from "../providers/anthropic.ts";
import { ClaudeCode } from "../providers/claude-code.ts";
import { GoogleAuth, NotConnectedError, parseClientFile } from "../providers/google-auth.ts";
import { GoogleCalendar, GoogleTasks } from "../providers/google.ts";
import { Keyring } from "../providers/keyring.ts";
import { SqliteHistory } from "../providers/sqlite.ts";
import { Awake } from "./awake.ts";
import { Pairing } from "./pairing.ts";
import { dataDir, socketPath } from "./paths.ts";
import { type Config, type Event, Lines, type Methods, type Request } from "./protocol.ts";
import { Savi } from "./savi.ts";
import { addressOn, Web } from "./web.ts";

declare const BUILD: string | undefined;
const build = typeof BUILD === "string" ? BUILD : "dev";

/** Models called with an API key. To add one: implement LLM, add a line here and to the setting's enum. */
const apiProviders: Record<string, (key: string, model: string) => LLM> = {
  anthropic: (key, model) => new AnthropicLLM(key, model || "claude-haiku-5-5"),
};

process.umask(0o077);
const dir = dataDir();
chmodSync(dir, 0o700);

// Held for the life of the process and released by the system, even after a crash.
const lock = new DatabaseSync(join(dir, "lock.db"));
try {
  lock.exec("BEGIN EXCLUSIVE");
} catch {
  process.exit(0); // already running
}

const history = new SqliteHistory(join(dir, "history.db"));
const secrets = new Keyring(process.env.SAVI_KEYRING);
const auth = new GoogleAuth(secrets);
const calendar = new GoogleCalendar(auth);
const tasks = new GoogleTasks(auth);

let config: Config = { provider: "claude-code", model: "", confirm: "modify", claudePath: "", phone: false, phoneInterface: "wt0", stayAwake: true, ...JSON.parse(history.getSetting("config") ?? "{}") };
const keyName = () => `llm.${config.provider}.key`;

async function createAssistant(tools: Tool[], c: Config): Promise<Assistant> {
  if (c.provider === "claude-code") {
    if (!c.claudePath || !existsSync(c.claudePath))
      throw new Error("Claude Code was not found. Install and sign in to the Claude Code extension, then reload VS Code.");
    const cwd = join(dir, "work"); // empty, so no project files are in reach
    mkdirSync(cwd, { recursive: true });
    return new ClaudeCode({ executable: c.claudePath, cwd, model: c.model }, tools);
  }
  const make = apiProviders[c.provider];
  if (!make) throw new Error("Unknown provider in savi.llm.provider.");
  const key = await secrets.get(keyName());
  if (!key) throw new Error("This provider needs an API key. Run 'Savi: Set Model API Key'.");
  return new Agent(make(key, c.model), tools);
}

const clients = new Set<Socket>();
const write = (socket: Socket, message: unknown) => void (socket.writable && socket.write(`${JSON.stringify(message)}\n`));
const emit = (e: Event) => {
  for (const c of clients) write(c, e);
  web.emit(e);
};

const savi = new Savi({ history, calendar, tasks, config: () => config, createAssistant, emit });

const pairing = new Pairing(history);
const web = new Web({
  dir, media: join(__dirname, "..", "media"), pairing, devices: history,
  state: () => ({ event: "state", state: savi.state() }),
  call: async (method, params) => {
    if (!Object.hasOwn(phoneMethods, method)) throw new Error("Not available on the phone.");
    return phoneMethods[method]!(params);
  },
});
const updateWeb = () => web.update(config.phone ? addressOn(config.phoneInterface) : undefined);
const awake = new Awake();
/** Follows settings, the private network and the charger. */
function tick() {
  awake.update(config.stayAwake);
  updateWeb().catch((e) => console.error("Phone access:", e));
}

let connecting: AbortController | undefined;

type Handlers = { [M in keyof Methods]: (p: Parameters<Methods[M]>[0], socket: Socket) => ReturnType<Methods[M]> | Promise<ReturnType<Methods[M]>> };
const handlers: Handlers = {
  hello: ({ config: c }) => {
    config = { ...config, ...c };
    history.setSetting("config", JSON.stringify(config));
    tick();
    return { build };
  },
  state: () => savi.state(),
  send: ({ text }) => savi.send(text, "vscode"),
  stop: () => savi.stop(),
  approve: ({ id, allow }) => savi.approve(id, allow === true),
  newConversation: () => savi.open(undefined),
  openConversation: ({ id }) => savi.open(id),
  deleteConversation: ({ id }) => savi.remove(id),
  conversations: () => history.conversations(200),
  conversation: ({ id }) => ({ messages: history.messages(id, 10_000), actions: history.actions(id, 10_000) }),
  search: ({ text }) => history.search({ text, limit: 50 }),
  agenda: async ({ days }) => {
    if (!(await auth.isConnected())) return { connected: false, events: [], tasks: [] };
    const today = toDate(new Date());
    try {
      const [events, open] = await Promise.all([
        calendar.listEvents(parseLocal(today), parseLocal(addDays(today, days))),
        tasks.listTasks(),
      ]);
      return { connected: true, events, tasks: open };
    } catch (e) {
      if (e instanceof NotConnectedError) return { connected: false, events: [], tasks: [] };
      throw e;
    }
  },
  act: ({ tool, input }) => savi.act(tool, input, "vscode"),
  googleHasClient: () => auth.hasClient(),
  googleSetClient: ({ json }) => auth.setClient(parseClientFile(json)),
  googleConnect: async (_, socket) => {
    connecting?.abort();
    const stop = (connecting = new AbortController());
    await auth.connect(
      async (url) => write(socket, { event: "openUrl", url } satisfies Event),
      AbortSignal.any([stop.signal, AbortSignal.timeout(5 * 60_000)]),
    );
    emit({ event: "agenda" });
  },
  googleCancel: () => connecting?.abort(),
  googleDisconnect: async () => {
    try { await auth.disconnect(); } finally { emit({ event: "agenda" }); }
  },
  hasApiKey: async () => (await secrets.get(keyName())) !== undefined,
  setApiKey: ({ key }) => (key ? secrets.store(keyName(), key) : secrets.delete(keyName())),
  phonePair: async () => {
    await updateWeb();
    if (!web.ip) throw new Error(`No address on ${config.phoneInterface}. Is NetBird connected?`);
    return { url: `${web.origin}/`, certificateUrl: web.certificateUrl, code: pairing.start() };
  },
  phoneDevices: () => history.devices(),
  phoneRemove: ({ id }) => {
    history.removeDevice(id);
    web.drop(id);
  },
  shutdown: () => void setTimeout(shutdown, 50),
};

/** All a phone can do: no settings, sign-in, pairing or deleting history. */
const phoneMethods: Record<string, (p: any) => unknown> = {
  send: ({ text }) => savi.send(String(text).slice(0, 20_000), "phone"),
  stop: () => savi.stop(),
  approve: ({ id, allow }) => savi.approve(String(id), allow === true),
  newConversation: () => savi.open(undefined),
  openConversation: ({ id }) => savi.open(Number(id)),
  conversations: () => history.conversations(200),
  search: ({ text }) => history.search({ text: String(text).slice(0, 500), limit: 50 }),
  agenda: () => handlers.agenda({ days: 7 }, undefined as never),
  completeTask: ({ id }) => savi.act("update_task", { id: String(id), completed: true }, "phone"),
};

const server = createServer((socket) => {
  const lines = new Lines();
  clients.add(socket);
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("close", () => clients.delete(socket));
  socket.on("data", (data) => {
    let requests: unknown[];
    try {
      requests = lines.push(String(data));
    } catch {
      return void socket.destroy();
    }
    for (const r of requests as Request[]) void answer(r, socket);
  });
});

async function answer({ id, method, params }: Request, socket: Socket) {
  try {
    if (!Object.hasOwn(handlers, method)) throw new Error(`Unknown method: ${method}`);
    const result = await (handlers[method] as (p: unknown, s: Socket) => unknown)(params, socket);
    write(socket, { id, result });
  } catch (e) {
    write(socket, { id, error: e instanceof Error ? e.message : String(e) });
  }
}

async function shutdown() {
  connecting?.abort();
  web.close();
  awake.release();
  server.close();
  await savi.stop();
  for (const c of clients) c.destroy();
  history.close();
  process.exit(0);
}

const backup = () => history.backup(join(dir, "backups")).catch((e) => console.error("Backup failed:", e));
void backup();
setInterval(backup, 3_600_000).unref(); // does nothing if today's copy exists

rmSync(socketPath(), { force: true }); // safe: we hold the lock
server.listen(socketPath());
tick();
setInterval(tick, 20_000);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
