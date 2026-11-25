import { backup, DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Conversation, Found, History, Outcome, SearchQuery, StoredAction, StoredMessage } from "../core/history.ts";
import { toDate } from "../core/time.ts";

const SCHEMA = `
CREATE TABLE conversation (id INTEGER PRIMARY KEY, startedAt TEXT NOT NULL, title TEXT NOT NULL);
CREATE TABLE message (
  id INTEGER PRIMARY KEY, conversationId INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  at TEXT NOT NULL, role TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, problem TEXT);
CREATE TABLE action (
  id INTEGER PRIMARY KEY, conversationId INTEGER REFERENCES conversation(id) ON DELETE CASCADE,
  at TEXT NOT NULL, source TEXT NOT NULL, tool TEXT NOT NULL, summary TEXT NOT NULL,
  outcome TEXT NOT NULL, result TEXT);
CREATE INDEX message_by_conversation ON message(conversationId);
CREATE INDEX action_by_conversation ON action(conversationId);
CREATE INDEX message_by_time ON message(at);
CREATE INDEX action_by_time ON action(at);
CREATE TABLE setting (name TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Marks (M*) belong to words in Indian scripts.
CREATE VIRTUAL TABLE message_text USING fts5(text, tokenize = "unicode61 categories 'L* N* Co Mn Mc'");
CREATE VIRTUAL TABLE action_text USING fts5(text, tokenize = "unicode61 categories 'L* N* Co Mn Mc'");
INSERT INTO message_text(message_text, rank) VALUES ('secure-delete', 1);
INSERT INTO action_text(action_text, rank) VALUES ('secure-delete', 1);
CREATE TRIGGER message_added AFTER INSERT ON message BEGIN
  INSERT INTO message_text(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER message_removed AFTER DELETE ON message BEGIN
  DELETE FROM message_text WHERE rowid = old.id; END;
CREATE TRIGGER action_added AFTER INSERT ON action BEGIN
  INSERT INTO action_text(rowid, text) VALUES (new.id, new.summary); END;
CREATE TRIGGER action_removed AFTER DELETE ON action BEGIN
  DELETE FROM action_text WHERE rowid = old.id; END;
PRAGMA user_version = 1;
`;

const KEEP_BACKUPS = 7;

const clean = <T>(row: unknown) =>
  Object.fromEntries(Object.entries(row as object).map(([k, v]) => [k, v ?? (k === "conversationId" ? null : undefined)])) as T;

export class SqliteHistory implements History {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA recursive_triggers = ON");
    const { user_version: version } = this.one<{ user_version: number }>("PRAGMA user_version")!;
    if (version === 0) this.db.exec(`BEGIN;${SCHEMA}COMMIT;`);
    else if (version !== 1) throw new Error("The history was made by a newer version of Savi.");
  }

  close() { this.db.close(); }

  getSetting(name: string) { return this.one<{ value: string }>("SELECT value FROM setting WHERE name = ?", name)?.value; }
  setSetting(name: string, value: string) {
    this.run("INSERT INTO setting VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value", name, value);
  }

  current() {
    const id = Number(this.getSetting("conversation"));
    return this.one("SELECT 1 FROM conversation WHERE id = ?", id) ? id : undefined;
  }
  setCurrent(id: number | undefined) {
    if (id !== undefined && !this.one("SELECT 1 FROM conversation WHERE id = ?", id)) throw new Error("No such conversation.");
    this.setSetting("conversation", String(id ?? ""));
  }

  conversations(limit: number) {
    return this.all<Conversation>(
      `SELECT c.* FROM conversation c LEFT JOIN message m ON m.conversationId = c.id
       GROUP BY c.id ORDER BY max(m.id) DESC, c.id DESC LIMIT ?`, limit);
  }

  startConversation(title: string): Conversation {
    const startedAt = new Date().toISOString();
    return { id: this.run("INSERT INTO conversation (startedAt, title) VALUES (?, ?)", startedAt, title), startedAt, title };
  }

  deleteConversation(id: number) {
    this.run("DELETE FROM conversation WHERE id = ?", id);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // so nothing lingers in the log
  }

  /** The latest ones, oldest first. */
  messages(conversationId: number, limit: number) {
    return this.all<StoredMessage>("SELECT * FROM message WHERE conversationId = ? ORDER BY id DESC LIMIT ?", conversationId, limit).reverse();
  }
  actions(conversationId: number, limit: number) {
    return this.all<StoredAction>("SELECT * FROM action WHERE conversationId = ? ORDER BY id DESC LIMIT ?", conversationId, limit).reverse();
  }

  addMessage(m: Omit<StoredMessage, "id" | "at">): StoredMessage {
    const at = new Date().toISOString();
    const id = this.run(
      "INSERT INTO message (conversationId, at, role, source, text, problem) VALUES (?, ?, ?, ?, ?, ?)",
      m.conversationId, at, m.role, m.source, m.text, m.problem ?? null);
    return { ...m, id, at };
  }

  addAction(a: Omit<StoredAction, "id" | "at" | "outcome" | "result">): StoredAction {
    const at = new Date().toISOString();
    const id = this.run(
      "INSERT INTO action (conversationId, at, source, tool, summary, outcome) VALUES (?, ?, ?, ?, ?, 'started')",
      a.conversationId, at, a.source, a.tool, a.summary);
    return { ...a, id, at, outcome: "started" };
  }
  finishAction(id: number, outcome: Outcome, result: string) {
    this.run("UPDATE action SET outcome = ?, result = ? WHERE id = ?", outcome, result, id);
  }

  search(q: SearchQuery): Found[] {
    const words = q.text?.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
    if (q.text?.trim() && !words.length) return [];
    const limit = q.limit ?? 20;
    const find = (kind: "message" | "action", match: string) => {
      const where: string[] = [], args: (string | number)[] = [];
      if (match) { where.push(`id IN (SELECT rowid FROM ${kind}_text WHERE ${kind}_text MATCH ?)`); args.push(match); }
      if (q.from) { where.push("at >= ?"); args.push(q.from.toISOString()); }
      if (q.to) { where.push("at < ?"); args.push(q.to.toISOString()); }
      return this.all<Found>(
        `SELECT '${kind}' AS kind, * FROM ${kind} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ?`,
        ...args, limit);
    };
    const run = (joiner: string) => {
      const match = words.map((w) => `"${w}"*`).join(joiner);
      return (["message", "action"] as const)
        .filter((k) => !q.kind || q.kind === k)
        .flatMap((k) => find(k, match))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, limit);
    };
    // All words first; any word if that finds nothing.
    const found = run(" AND ");
    return found.length || words.length < 2 ? found : run(" OR ");
  }

  /** One copy per day, the last seven kept. */
  async backup(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `savi-${toDate(new Date())}.db`);
    if (existsSync(file)) return;
    await backup(this.db, `${file}.part`);
    renameSync(`${file}.part`, file);
    const old = readdirSync(dir).filter((f) => /^savi-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -KEEP_BACKUPS);
    for (const f of old) rmSync(join(dir, f));
  }

  private all<T>(sql: string, ...args: (string | number)[]) {
    return this.db.prepare(sql).all(...args).map((r) => clean<T>(r));
  }
  private one<T>(sql: string, ...args: (string | number)[]) { return this.db.prepare(sql).get(...args) as T | undefined; }
  private run(sql: string, ...args: (string | number | null)[]) { return Number(this.db.prepare(sql).run(...args).lastInsertRowid); }
}
