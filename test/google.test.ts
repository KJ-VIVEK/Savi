import assert from "node:assert/strict";
import { test } from "node:test";
import { GoogleAuth, NotConnectedError, parseClientFile } from "../src/providers/google-auth.ts";
import { GoogleCalendar, GoogleTasks, movedEnd } from "../src/providers/google.ts";
import { event } from "./helpers.ts";

type Call = { method: string; url: string; body: any };
function google(...replies: [number, unknown?][]) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url: String(url), body: init.body && JSON.parse(String(init.body)) });
    const [status, body] = replies.shift()!;
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
  }) as typeof fetch;
  return { calls, fetcher };
}
const auth = { accessToken: async () => "tok" };
const allDay = { id: "a", summary: "Trip", start: { date: "2026-12-01" }, end: { date: "2026-12-04" } };

test("all-day ends are inclusive here and exclusive at Google", async () => {
  const g = google([200, allDay]);
  const out = await new GoogleCalendar(auth, g.fetcher).createEvent({ title: "Trip", start: "2026-12-01", end: "2026-12-03" });
  assert.equal(g.calls[0]!.body.end.date, "2026-12-04");
  assert.equal(out.end, "2026-12-03");
});

test("moving only the start keeps the length", () => {
  assert.equal(movedEnd(event, "2026-11-26T23:45:00"), "2026-11-27T00:15:00");
  assert.equal(movedEnd({ ...event, start: "2026-12-01", end: "2026-12-03" }, "2026-12-31"), "2027-01-02");
  assert.throws(() => movedEnd(event, "2026-12-31"));
});

test("switching to timed clears the all-day fields", async () => {
  const g = google([200, allDay], [200, allDay]);
  await new GoogleCalendar(auth, g.fetcher).updateEvent("a", { start: "2026-12-01T09:00", end: "2026-12-01T10:00" });
  const { start } = g.calls[1]!.body;
  assert.equal(start.date, null);
  assert.equal(start.dateTime, "2026-12-01T09:00:00");
});

test("follows pages, retries once on 401, surfaces Google's message", async () => {
  const g = google([401], [200, { items: [{ id: "1" }], nextPageToken: "p2" }], [200, { items: [{ id: "2", due: "2026-12-01T00:00:00.000Z" }] }]);
  const list = await new GoogleTasks(auth, g.fetcher).listTasks();
  assert.deepEqual(list.map((t) => t.id), ["2", "1"]);
  assert.match(g.calls[2]!.url, /pageToken=p2/);
  const bad = google([403, { error: { message: "API disabled" } }]);
  await assert.rejects(new GoogleTasks(auth, bad.fetcher).listTasks(), /API disabled/);
});

test("delete accepts an empty response and escapes the ID", async () => {
  const g = google([204]);
  await new GoogleCalendar(auth, g.fetcher).deleteEvent("a/b");
  assert.match(g.calls[0]!.url, /a%2Fb$/);
});

const SCOPE = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks";
function setup(reply: object, status = 200) {
  const map = new Map<string, string>(), posts: URLSearchParams[] = [];
  const secrets = {
    get: async (k: string) => map.get(k), store: async (k: string, v: string) => void map.set(k, v),
    delete: async (k: string) => void map.delete(k),
  };
  const fetcher = (async (_: string, init: RequestInit) => {
    posts.push(init.body as URLSearchParams);
    return Response.json(reply, { status });
  }) as unknown as typeof fetch;
  return { map, posts, auth: new GoogleAuth(secrets, fetcher) };
}
const client = parseClientFile('{"installed":{"client_id":"id","client_secret":"sec"}}');

async function signIn(a: GoogleAuth) {
  await a.setClient(client);
  await a.connect(async (u) => {
    const url = new URL(u), back = url.searchParams.get("redirect_uri")!;
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal((await fetch(`${back}/?code=evil&state=wrong`)).status, 404);
    assert.equal((await fetch(`${back}/?code=good&state=${url.searchParams.get("state")}`)).status, 200);
  }, AbortSignal.timeout(5000));
}

test("loopback sign-in ignores a wrong state and stores tokens", async () => {
  const s = setup({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: SCOPE });
  await signIn(s.auth);
  assert.equal(s.posts[0]!.get("code"), "good");
  assert.ok(s.posts[0]!.get("code_verifier"));
  assert.equal(await s.auth.accessToken(), "a");
});

test("partial consent is rejected", async () => {
  const s = setup({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: SCOPE.split(" ")[0] });
  await assert.rejects(signIn(s.auth), /both/);
  assert.equal(await s.auth.isConnected(), false);
});

test("cancelling sign-in rejects", async () => {
  const s = setup({});
  await s.auth.setClient(client);
  const stop = new AbortController();
  await assert.rejects(s.auth.connect(async () => stop.abort(), stop.signal), /cancelled/);
});

test("parallel calls share one refresh; an expired grant signs out", async () => {
  const s = setup({ access_token: "new", expires_in: 3600 });
  await s.auth.setClient(client);
  const old = JSON.stringify({ access: "old", refresh: "r", expires: 0 });
  s.map.set("google.tokens", old);
  assert.deepEqual(await Promise.all([s.auth.accessToken(), s.auth.accessToken()]), ["new", "new"]);
  assert.equal(s.posts.length, 1);

  const x = setup({ error: "invalid_grant" }, 400);
  await x.auth.setClient(client);
  x.map.set("google.tokens", old);
  await assert.rejects(x.auth.accessToken(), NotConnectedError);
  assert.equal(await x.auth.isConnected(), false);
});

test("rejects the wrong client file", () => {
  assert.throws(() => parseClientFile('{"web":{"client_id":"x"}}'), /Desktop/);
  assert.throws(() => parseClientFile("nope"), /JSON/);
});
