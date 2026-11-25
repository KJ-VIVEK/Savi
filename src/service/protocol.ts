/** JSON, one message per line, over a Unix socket only this user can open. */
import type { CalendarEvent, Task } from "../core/calendar.ts";
import type { Conversation, Found, StoredAction, StoredMessage } from "../core/history.ts";

export interface Config {
  provider: string;
  model: string;
  confirm: "all" | "modify";
  claudePath: string;
}

export interface Approval { id: string; summary: string }

export interface State {
  conversation?: number;
  messages: StoredMessage[];
  actions: StoredAction[];
  busy: boolean;
  /** Text of the reply being written. */
  partial: string;
  approvals: Approval[];
}

export interface Agenda { connected: boolean; events: CalendarEvent[]; tasks: Task[] }

export interface Methods {
  hello(p: { config: Config }): { build: string };
  state(p: {}): State;
  send(p: { text: string }): void;
  stop(p: {}): void;
  approve(p: { id: string; allow: boolean }): void;
  newConversation(p: {}): void;
  openConversation(p: { id: number }): void;
  deleteConversation(p: { id: number }): void;
  conversations(p: {}): Conversation[];
  conversation(p: { id: number }): { messages: StoredMessage[]; actions: StoredAction[] };
  search(p: { text: string }): Found[];
  agenda(p: { days: number }): Agenda;
  /** Runs a tool the user invoked directly; it is logged but not asked about again. */
  act(p: { tool: string; input: unknown }): void;
  googleHasClient(p: {}): boolean;
  googleSetClient(p: { json: string }): void;
  googleConnect(p: {}): void;
  googleCancel(p: {}): void;
  googleDisconnect(p: {}): void;
  hasApiKey(p: {}): boolean;
  setApiKey(p: { key: string }): void;
  shutdown(p: {}): void;
}

export type Event =
  | { event: "state"; state: State }
  | { event: "message"; message: StoredMessage }
  | { event: "text"; delta: string }
  | { event: "tool"; name: string }
  | { event: "approval"; approval: Approval }
  | { event: "approved"; id: string }
  | { event: "done"; problem?: string }
  | { event: "agenda" }
  /** Sent only to the client that asked to connect. */
  | { event: "openUrl"; url: string };

export type Request = { id: number; method: keyof Methods; params: unknown };
export type Reply = { id: number; result?: unknown; error?: string };

export class Lines {
  private buffer = "";
  /** Returns the complete messages in the data so far. */
  push(data: string): unknown[] {
    const parts = (this.buffer + data).split("\n");
    this.buffer = parts.pop()!;
    if (this.buffer.length > 8_000_000) throw new Error("Message too large");
    return parts.filter(Boolean).map((p) => JSON.parse(p));
  }
}
