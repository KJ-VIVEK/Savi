import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Coding, CodingSession } from "../core/coding.ts";
import { subscriptionEnv } from "./claude-code.ts";

const START_WAIT = 12_000;

export interface RemoteControlOptions {
  executable: () => string;
  folders: () => string[];
  model: () => string;
  dir: string;
}

/** Claude Code Remote Control, one server per project, until stopped or Savi ends. */
export class RemoteControl implements Coding {
  private options: RemoteControlOptions;
  private running = new Map<string, { child: ChildProcess; session: CodingSession }>();
  constructor(options: RemoteControlOptions) { this.options = options; }

  /** Only folders the user listed, by name: a model can never supply a path. */
  private folder(project: string) {
    return this.options.folders().find((f) => basename(f).toLowerCase() === project.toLowerCase());
  }
  projects() { return this.options.folders().map((f) => basename(f)); }
  sessions() { return [...this.running.values()].map((r) => r.session); }

  async start(project: string): Promise<CodingSession> {
    const folder = this.folder(project);
    if (!folder) throw new Error(`"${project}" is not in the savi.code.projects setting.`);
    if (!existsSync(folder)) throw new Error(`${folder} does not exist. Is its drive mounted?`);
    const name = basename(folder);
    const existing = this.running.get(name);
    if (existing) return existing.session;

    const settings = join(this.options.dir, "coding.json");
    writeFileSync(settings, JSON.stringify({ model: this.options.model() || "sonnet" }), { mode: 0o600 });
    const child = spawn(
      this.options.executable(),
      ["remote-control", "--name", `Savi: ${name}`, "--settings", settings, "--permission-mode", "default"],
      { cwd: folder, env: subscriptionEnv(process.env), stdio: ["ignore", "pipe", "pipe"] },
    );
    const entry: { child: ChildProcess; session: CodingSession } = { child, session: { project: name, startedAt: new Date().toISOString() } };
    this.running.set(name, entry);
    const forget = () => { if (this.running.get(name) === entry) this.running.delete(name); };

    return new Promise((resolve, reject) => {
      let output = "";
      // Running without printing a link is still a started session.
      const timer = setTimeout(() => resolve(entry.session), START_WAIT);
      const read = (data: Buffer) => {
        output = (output + data.toString("utf8")).slice(-8000);
        const link = findLink(output);
        if (!link || entry.session.link) return;
        entry.session.link = link;
        clearTimeout(timer);
        resolve(entry.session);
      };
      child.stdout!.on("data", read);
      child.stderr!.on("data", read);
      child.on("error", (e) => {
        clearTimeout(timer);
        forget();
        reject(e);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        forget();
        reject(new Error(explain(output)));
      });
    });
  }

  async stop(project: string) {
    const entry = [...this.running.values()].find((r) => r.session.project.toLowerCase() === project.toLowerCase());
    if (!entry) throw new Error(`No coding session is running on "${project}".`);
    await end(entry.child);
  }

  async stopAll() { await Promise.all([...this.running.values()].map((r) => end(r.child))); }
}

function end(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGINT");
  });
}

const plain = (s: string) => s.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** A link to a session, not the general page. */
export function findLink(output: string) {
  return /https:\/\/claude\.ai\/code[/?][A-Za-z0-9_\-=/?&%.]+(?=\s)/.exec(plain(output))?.[0];
}

function explain(output: string) {
  const text = plain(output);
  if (/Enable Remote Control\?/.test(text))
    return "Remote Control needs your consent once. In a terminal on the PC, run 'claude remote-control' in the project and answer y.";
  if (/trust/i.test(text)) return "Claude Code does not trust this folder yet. Open it in Claude Code on the PC once and accept.";
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  return `Remote Control stopped${last ? `: ${last.slice(0, 300)}` : "."}`;
}
