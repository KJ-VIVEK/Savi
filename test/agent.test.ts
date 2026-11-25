import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { Agent } from "../src/core/agent.ts";
import type { LLM, LLMRequest, LLMResponse, Message } from "../src/core/llm.ts";
import { createTools } from "../src/core/tools.ts";
import { toParam } from "../src/providers/anthropic.ts";
import { fakes } from "./helpers.ts";

const say = (text: string): LLMResponse => ({ stop: "end", message: { role: "assistant", text, toolCalls: [] } });
const call = (name: string, input: unknown, stop: LLMResponse["stop"] = "tools"): LLMResponse => ({
  stop, message: { role: "assistant", text: "", toolCalls: [{ id: "c1", name, input }] },
});

function script(...replies: LLMResponse[]) {
  const seen: Message[][] = [];
  const llm: LLM = {
    complete: async (r: LLMRequest) => {
      seen.push([...r.messages]);
      return replies.shift()!;
    },
  };
  return { llm, seen };
}
const hooks = (ok: boolean, asked: string[] = []) => ({
  needsApproval: (e: string) => e === "modify",
  approve: async (s: string) => { asked.push(s); return ok; },
});
const lastResult = (seen: Message[][]) => {
  const m = seen.at(-1)!.at(-1)!;
  assert.equal(m.role, "tool");
  return m.role === "tool" ? m.results[0]! : undefined!;
};

test("creates without approval", async () => {
  const f = fakes();
  const { llm, seen } = script(call("create_task", { title: "Buy milk" }), say("Done"));
  await new Agent(llm, createTools(f.calendar, f.tasks)).send({ text: "buy milk", context: [] }, hooks(false));
  assert.deepEqual(f.calls, ['createTask [{"title":"Buy milk"}]']);
  assert.equal(lastResult(seen).isError, false);
});

test("a declined delete never runs and names the item", async () => {
  const f = fakes(), asked: string[] = [];
  const { llm, seen } = script(call("delete_event", { id: "e1" }), say("OK"));
  await new Agent(llm, createTools(f.calendar, f.tasks)).send({ text: "cancel standup", context: [] }, hooks(false, asked));
  assert.ok(!f.calls.some((c) => c.startsWith("deleteEvent")));
  assert.match(asked[0]!, /Standup/);
  assert.match(lastResult(seen).content, /declined/);
});

test("invalid input is returned to the model, not run", async () => {
  const f = fakes();
  for (const input of [
    { kind: "event", title: "x", start: "2026-02-30", end: "2026-02-30" },
    { kind: "event", title: "x", start: "2026-11-26T10:00:00", end: "2026-11-26T09:00:00" },
    { kind: "event", title: "x", start: "2026-11-26T10:00:00", end: "2026-11-26" },
    { kind: "event", title: "x", start: "2026-11-26", end: "2026-11-26", attendees: ["a@b.c"] },
  ]) {
    const { llm, seen } = script(call("create_event", input), say("sorry"));
    await new Agent(llm, createTools(f.calendar, f.tasks)).send({ text: "x", context: [] }, hooks(true));
    assert.equal(lastResult(seen).isError, true);
  }
  assert.deepEqual(f.calls, []);
});

test("tool calls in cut-off or refused turns never run", async () => {
  for (const stop of ["length", "refused"] as const) {
    const f = fakes();
    const { llm } = script(call("delete_event", { id: "e1" }, stop));
    await assert.rejects(new Agent(llm, createTools(f.calendar, f.tasks)).send({ text: "x", context: [] }, hooks(true)));
    assert.deepEqual(f.calls, []);
  }
});

test("stopping during approval prevents the action", async () => {
  const f = fakes(), stop = new AbortController();
  const { llm } = script(call("delete_event", { id: "e1" }));
  const agent = new Agent(llm, createTools(f.calendar, f.tasks));
  await assert.rejects(agent.send({ text: "x", context: [] }, { ...hooks(true), approve: async () => { stop.abort(); return true; } }, stop.signal));
  assert.ok(!f.calls.some((c) => c.startsWith("deleteEvent")));
});

test("Claude turns replay verbatim; other providers' turns are translated", () => {
  const content = [{ type: "thinking", thinking: "", signature: "s" }];
  const base = { role: "assistant" as const, text: "hi", toolCalls: [] };
  assert.equal(toParam({ ...base, native: { provider: "anthropic", content } }).content, content);
  assert.deepEqual(toParam({ ...base, native: { provider: "other", content } }).content, [{ type: "text", text: "hi" }]);
});

test("core imports only core and zod", () => {
  for (const f of readdirSync("src/core"))
    for (const [, from] of readFileSync(`src/core/${f}`, "utf8").matchAll(/from "([^"]+)"/g))
      assert.ok(from === "zod" || /^\.\/\w+\.ts$/.test(from!), `${f} imports ${from}`);
});
