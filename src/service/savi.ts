import { randomUUID } from "node:crypto";
import { type AgentHooks, type Assistant, runTool, type Turn } from "../core/agent.ts";
import type { CalendarService, TaskService } from "../core/calendar.ts";
import type { History, Source, StoredAction } from "../core/history.ts";
import { createHistoryTools } from "../core/history-tools.ts";
import { toLocal } from "../core/time.ts";
import { createTools, type Tool } from "../core/tools.ts";
import type { Approval, Config, Event, State } from "./protocol.ts";

const APPROVAL_TIMEOUT = 9 * 60_000; // shorter than the tool timeout, so a late click cannot act
const CONTEXT_MESSAGES = 30;
const CONTEXT_CHARS = 16_000;

/** One conversation shared by every client. */
export class Savi {
  private history: History;
  private tools: Tool[];
  private createAssistant: (tools: Tool[], config: Config) => Promise<Assistant>;
  private emit: (e: Event) => void;
  private config: () => Config;
  private approvals = new Map<string, Approval & { settle: (allow: boolean) => void }>();
  private run?: { stop: AbortController; done: Promise<void>; partial: string };

  constructor(deps: {
    history: History; calendar: CalendarService; tasks: TaskService; config: () => Config;
    createAssistant: (tools: Tool[], config: Config) => Promise<Assistant>; emit: (e: Event) => void;
  }) {
    this.history = deps.history;
    this.tools = [...createTools(deps.calendar, deps.tasks), ...createHistoryTools(deps.history)];
    this.createAssistant = deps.createAssistant;
    this.emit = deps.emit;
    this.config = deps.config;
  }

  state(): State {
    const conversation = this.history.current();
    return {
      conversation,
      messages: conversation ? this.history.messages(conversation, 200) : [],
      actions: conversation ? this.history.actions(conversation, 200) : [],
      busy: this.run !== undefined,
      partial: this.run?.partial ?? "",
      approvals: [...this.approvals.values()].map(({ id, summary }) => ({ id, summary })),
    };
  }

  /** Returns once accepted; progress arrives as events. */
  send(text: string, source: Source) {
    text = text.trim();
    if (!text) return;
    if (this.run) throw new Error("Savi is still working on the previous request.");
    let conversation = this.history.current();
    if (conversation === undefined) {
      conversation = this.history.startConversation(text.replace(/\s+/g, " ").slice(0, 60)).id;
      this.history.setCurrent(conversation);
    }
    const turn: Turn = { text, context: this.context(conversation) };
    const message = this.history.addMessage({ conversationId: conversation, role: "user", source, text });
    this.emit({ event: "message", message });
    const run = { stop: new AbortController(), done: Promise.resolve(), partial: "" };
    this.run = run;
    run.done = this.reply(run, turn, conversation, source);
  }

  async stop() {
    const run = this.run;
    if (!run) return;
    run.stop.abort();
    for (const a of [...this.approvals.values()]) a.settle(false);
    await run.done;
  }

  approve(id: string, allow: boolean) { this.approvals.get(id)?.settle(allow); }

  async open(id: number | undefined) {
    await this.stop();
    this.history.setCurrent(id);
    this.emit({ event: "state", state: this.state() });
  }

  async remove(id: number) {
    if (this.history.current() === id) await this.stop();
    this.history.deleteConversation(id);
    this.emit({ event: "state", state: this.state() });
  }

  async act(name: string, input: unknown, source: Source) {
    const tool = this.tools.find((t) => t.spec.name === name);
    if (!tool) throw new Error(`Unknown action: ${name}`);
    const { content, isError } = await runTool(tool, input, {
      ...this.recorder(null, source), needsApproval: () => false, approve: async () => false,
    });
    if (isError) throw new Error(content);
  }

  private async reply(run: NonNullable<Savi["run"]>, turn: Turn, conversationId: number, source: Source) {
    let problem: string | undefined;
    try {
      const assistant = await this.createAssistant(this.tools, this.config());
      await assistant.send(turn, {
        ...this.recorder(conversationId, source),
        onText: (delta) => {
          run.partial += delta;
          this.emit({ event: "text", delta });
        },
        onTool: (name) => {
          if (run.partial && !run.partial.endsWith("\n")) run.partial += "\n";
          this.emit({ event: "tool", name });
        },
        needsApproval: (effect) => effect === "modify" || (effect === "create" && this.config().confirm === "all"),
        approve: (summary) => this.ask(summary, run.stop.signal),
      }, run.stop.signal);
    } catch (e) {
      problem = run.stop.signal.aborted ? "Stopped." : e instanceof Error ? e.message : String(e);
    }
    try {
      if (run.partial.trim() || problem)
        this.history.addMessage({ conversationId, role: "assistant", source, text: run.partial.trim(), problem });
    } catch (e) {
      problem = `Could not save the reply: ${e instanceof Error ? e.message : e}`;
    }
    this.run = undefined;
    this.emit({ event: "done", problem });
  }

  private ask(summary: string, signal: AbortSignal) {
    if (signal.aborted) return Promise.resolve(false);
    const id = randomUUID();
    return new Promise<boolean>((resolve) => {
      const settle = (allow: boolean) => {
        clearTimeout(timer);
        if (!this.approvals.delete(id)) return; // the first answer counts
        this.emit({ event: "approved", id });
        resolve(allow);
      };
      const timer = setTimeout(() => settle(false), APPROVAL_TIMEOUT);
      this.approvals.set(id, { id, summary, settle });
      this.emit({ event: "approval", approval: { id, summary } });
    });
  }

  private recorder(conversationId: number | null, source: Source): Pick<AgentHooks, "onChange" | "record"> {
    return {
      onChange: () => this.emit({ event: "agenda" }),
      record: (tool, summary) => {
        const { id } = this.history.addAction({ conversationId, source, tool, summary });
        return (outcome, result) => this.history.finishAction(id, outcome, result);
      },
    };
  }

  /** Recent turns from Savi's own record, so any provider can pick up the conversation. */
  private context(conversationId: number): Turn["context"] {
    const messages = this.history.messages(conversationId, CONTEXT_MESSAGES);
    const actions = this.history.actions(conversationId, 100);
    const out: Turn["context"] = [];
    let size = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      const since = messages[i - 1]?.at ?? "";
      const did = m.role === "assistant" ? actions.filter((a) => a.at > since && a.at <= m.at).map(line) : [];
      const text = [m.text, m.problem && `[${m.problem}]`, ...did].filter(Boolean).join("\n").slice(0, CONTEXT_CHARS / 2);
      if ((size += text.length) > CONTEXT_CHARS) break;
      out.unshift({ role: m.role, at: toLocal(new Date(m.at)), text });
    }
    return out;
  }
}

const line = (a: StoredAction) =>
  `[action ${a.outcome === "started" ? "result unknown" : a.outcome}: ${a.summary.replace(/\n/g, "; ")}${a.result ? ` -> ${a.result.slice(0, 600)}` : ""}]`;
