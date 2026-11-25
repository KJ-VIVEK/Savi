import assert from "node:assert/strict";
import { test } from "node:test";
import { completeEvent } from "../src/core/draft.ts";
import { GoogleCalendar, GoogleTasks } from "../src/providers/google.ts";
import { subscriptionEnv } from "../src/providers/claude-code.ts";

const auth = { accessToken: async () => "t" };
function google(...replies: object[]) {
  const bodies: any[] = [];
  return { bodies, fetcher: (async (_: string, i: RequestInit) => {
    bodies.push(i.body && JSON.parse(String(i.body)));
    return Response.json(replies.shift());
  }) as unknown as typeof fetch };
}

test("kinds fill in their defaults", () => {
  const r = completeEvent({ kind: "reminder", title: "Call", start: "2026-11-26T23:50:00" });
  assert.equal(r.end, "2026-11-27T00:05:00");
  assert.deepEqual(r.reminderMinutes, [0]);
  assert.equal(r.busy, false);
  const b = completeEvent({ kind: "birthday", title: "Sam", start: "2028-02-29" });
  assert.match(b.recurrence!, /BYMONTHDAY=-1/);
  assert.equal(b.end, "2028-02-29");
  assert.throws(() => completeEvent({ kind: "birthday", title: "Sam", start: "2026-01-01T09:00:00" }));
});

test("priority becomes a Google colour and back", async () => {
  const day = { date: "2026-12-01" };
  const g = google({ id: "1", start: day, end: { date: "2026-12-02" }, colorId: "11", extendedProperties: { private: { saviKind: "reminder" } } });
  const out = await new GoogleCalendar(auth, g.fetcher).createEvent({ title: "x", start: "2026-12-01", end: "2026-12-01", priority: "high", kind: "reminder" });
  assert.equal(g.bodies[0].colorId, "11");
  assert.equal(out.priority, "high");
  assert.equal(out.kind, "reminder");
});

test("task priority and notes survive separate edits", async () => {
  const old = { id: "1", title: "x", notes: "two lines\nhere\nPriority: low" };
  const g = google(old, old, old, old);
  const t = new GoogleTasks(auth, g.fetcher);
  await t.updateTask("1", { priority: "high" });
  assert.equal(g.bodies[1].notes, "two lines\nhere\nPriority: high");
  const out = await t.updateTask("1", { notes: "new" });
  assert.equal(g.bodies[3].notes, "new\nPriority: low");
  assert.equal(out.notes, "two lines\nhere");
});

test("API credentials never reach Claude Code", () => {
  assert.deepEqual(subscriptionEnv({ HOME: "/h", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", CLAUDECODE: "1" }), { HOME: "/h" });
});
