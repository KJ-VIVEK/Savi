export type Source = "vscode" | "phone";
export type Outcome = "started" | "done" | "declined" | "failed";

export interface Conversation { id: number; startedAt: string; title: string }

/** Times are ISO 8601 UTC. */
export interface StoredMessage {
  id: number; conversationId: number; at: string; role: "user" | "assistant"; source: Source; text: string;
  /** Set when a reply did not finish. */
  problem?: string;
}

/** "started" that never changes means Savi stopped midway, so the result is unknown. */
export interface StoredAction {
  id: number; conversationId: number | null; at: string; source: Source; tool: string; summary: string;
  outcome: Outcome; result?: string;
}

export interface SearchQuery {
  text?: string;
  /** Bounds as instants: from inclusive, to exclusive. */
  from?: Date;
  to?: Date;
  kind?: "message" | "action";
  limit?: number;
}

export type Found = ({ kind: "message" } & StoredMessage) | ({ kind: "action" } & StoredAction);

export interface History {
  /** The shared conversation; survives restarts. Undefined until the first message. */
  current(): number | undefined;
  setCurrent(id: number | undefined): void;
  conversations(limit: number): Conversation[];
  startConversation(title: string): Conversation;
  deleteConversation(id: number): void;
  messages(conversationId: number, limit: number): StoredMessage[];
  actions(conversationId: number, limit: number): StoredAction[];
  addMessage(m: Omit<StoredMessage, "id" | "at">): StoredMessage;
  addAction(a: Omit<StoredAction, "id" | "at" | "outcome" | "result">): StoredAction;
  finishAction(id: number, outcome: Outcome, result: string): void;
  search(q: SearchQuery): Found[];
}
