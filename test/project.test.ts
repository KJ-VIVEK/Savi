import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTool } from "../src/core/agent.ts";
import { rule } from "../src/providers/guard.ts";
import { codingEnv } from "../src/providers/claude-coder.ts";
import { SqliteHistory } from "../src/providers/sqlite.ts";
import { Savi } from "../src/service/savi.ts";
import { fakes } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "savi-test-"));
mkdirSync(join(dir, "p", "src"), { recursive: true });
symlinkSync("/etc", join(dir, "p", "link"));
const at = (tool: string, input: Record<string, unknown>) => Object.keys(rule(tool, input, join(dir, "p")))[0];

test("the guard keeps files inside and asks for edits and commands", () => {
  assert.equal(at("Read", { file_path: "src/a.ts" }), "allow");
  assert.equal(at("Grep", { pattern: "/api/../x" }), "allow");
  for (const p of ["/etc/passwd", "../x", "link/passwd", join(dir, "p-other/x")]) {
    assert.equal(at("Read", { file_path: p }), "deny", p);
    assert.equal(at("Write", { file_path: p, content: "" }), "deny", p);
  }
  assert.equal(at("Glob", { pattern: "../**" }), "deny");
  assert.equal(at("Grep", { pattern: "x", glob: "../*" }), "deny");
  assert.equal(at("Edit", { file_path: "src/new/a.ts", old_string: "a", new_string: "b" }), "ask");
  for (const p of [".git/hooks/pre-commit", ".claude/settings.json", "src/.vscode/tasks.json"]) assert.equal(at("Write", { file_path: p, content: "" }), "deny", p);
  assert.equal(at("Bash", { command: "npm test" }), "ask");
  assert.equal(at("Bash", { command: "git status # results" }), "ask");
  for (const c of ["sudo rm x", "true;sudo x", "/usr/bin/sudo x", "pkexec x", "echo \u202e x", ""]) assert.equal(at("Bash", { command: c }), "deny", c);
  assert.equal(at("Bash", { command: "x", run_in_background: true }), "deny");
  for (const t of ["WebFetch", "Task", "NotebookEdit", "mcp__x__y"]) assert.equal(at(t, {}), "deny");
});

test("secrets and the keyring bus stay out of commands", () => {
  assert.deepEqual(codingEnv({ PATH: "/bin", GITHUB_TOKEN: "x", DBUS_SESSION_BUS_ADDRESS: "x", SSH_AUTH_SOCK: "x", MY_API_KEY: "x" }), { PATH: "/bin" });
});

test("connecting hands work over, continues the session, and leaves again", async () => {
  const f = fakes(), history = new SqliteHistory(":memory:"), events: any[] = [], turns: unknown[] = [];
  const savi = new Savi({
    history, store: history, calendar: f.calendar, tasks: f.tasks, projects: () => ["Demo"],
    config: () => ({ confirm: "modify" }) as never,
    emit: (e) => { events.push(e); if (e.event === "approval") savi.approve(e.approval.id, true); },
    code: async (p, text, session) => { turns.push([p, text, session]); return "s1"; },
    createAssistant: async (tools) => ({ send: async (_, h, sig) => {
      const r = await runTool(tools.find((t) => t.spec.name === "connect_project")!, { project: "demo", request: "add dark mode" }, h, sig);
      h.onText?.(r.isError ? r.content : "Connected.");
    } }),
  });
  const say = async (t: string) => {
    const n = events.filter((e) => e.event === "done").length;
    savi.send(t, "phone");
    while (events.filter((e) => e.event === "done").length === n) await new Promise((r) => setTimeout(r, 2));
  };
  await say("connect to demo and add dark mode");
  assert.equal(savi.state().project, "Demo");
  await say("now add tests");
  assert.deepEqual(turns, [["Demo", "add dark mode", undefined], ["Demo", "now add tests", "s1"]]);
  await say("leave the login page alone and fix the footer");
  assert.equal(turns.length, 3, "a sentence that starts with leave is still work");
  await say("disconnect");
  assert.equal(savi.state().project, undefined);
  assert.equal(turns.length, 3);
  assert.equal(history.actions(history.current()!, 9)[0]!.outcome, "done");
});
