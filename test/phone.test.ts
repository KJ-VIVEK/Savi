import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { request as httpGet } from "node:http";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { unitText } from "../src/extension/autostart.ts";
import { SqliteHistory } from "../src/providers/sqlite.ts";
import { pluggedIn } from "../src/service/awake.ts";
import { certificateFor } from "../src/service/certificate.ts";
import { Pairing } from "../src/service/pairing.ts";
import { Web } from "../src/service/web.ts";

const temp = () => mkdtempSync(join(tmpdir(), "savi-test-"));

test("pairing codes work once, and stop after five wrong tries", () => {
  const store = new SqliteHistory(":memory:"), p = new Pairing(store);
  assert.equal(p.redeem("", "x"), undefined);
  const code = p.start();
  const token = p.redeem(`${code.slice(0, 4).toLowerCase()} ${code.slice(4)}`, "phone")!;
  assert.ok(p.device(token));
  assert.equal(p.redeem(code, "x"), undefined);
  const next = p.start();
  for (let i = 0; i < 5; i++) assert.equal(p.redeem("WRONG", "x"), undefined);
  assert.equal(p.redeem(next, "x"), undefined);
  store.removeDevice(p.device(token)!);
  assert.equal(p.device(token), undefined);
});

test("certificate covers one address, verifies, and is reused", async () => {
  const dir = temp(), a = await certificateFor("127.0.0.1", dir);
  const ca = new X509Certificate(a.ca), leaf = new X509Certificate(a.cert);
  assert.ok(ca.ca && !leaf.ca && leaf.verify(ca.publicKey) && leaf.checkIP("127.0.0.1"));
  assert.equal((await certificateFor("127.0.0.1", dir)).cert, a.cert);
  assert.notEqual((await certificateFor("127.0.0.2", dir)).cert, a.cert);
  assert.deepEqual(readdirSync(dir), ["certificate.json"]);
});

test("the web server only serves paired devices from its own origin", async () => {
  const dir = temp(), store = new SqliteHistory(":memory:"), pairing = new Pairing(store), called: string[] = [];
  const web = new Web({
    dir, media: "media", pairing, devices: store, ports: { https: 18787, http: 18788 },
    state: () => ({ event: "agenda" }),
    call: async (m) => { called.push(m); return "ok"; },
  });
  await web.update("127.0.0.1");
  const { ca } = await certificateFor("127.0.0.1", dir);
  const ask = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    new Promise<{ status: number; text: string; headers: any }>((ok, no) => {
      const r = request({ host: "127.0.0.1", port: 18787, path, method, ca, headers, agent: false, ...(headers.host ? { checkServerIdentity: () => undefined } : {}) }, (res) => {
        let text = "";
        res.on("data", (d) => {
          text += d;
          if (path === "/events" && res.statusCode === 200) { ok({ status: 200, text, headers: res.headers }); r.destroy(); }
        });
        res.on("end", () => ok({ status: res.statusCode!, text, headers: res.headers }));
      });
      r.on("error", no);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const plain = (path: string) => new Promise<number>((ok, no) => httpGet({ host: "127.0.0.1", port: 18788, path, agent: false }, (r) => { r.resume(); ok(r.statusCode!); }).on("error", no).end());
  const origin = { origin: web.origin };
  try {
    assert.equal((await ask("GET", "/")).status, 200); // TLS verified against our CA
    for (const f of ["/app.js", "/chat.js", "/app.css", "/chat.css", "/icon.svg", "/manifest.webmanifest"]) assert.equal((await ask("GET", f)).status, 200, f);
    assert.equal((await ask("GET", "/../package.json")).status, 401);
    assert.equal((await ask("GET", "/", { host: "evil.example" })).status, 421);
    assert.equal((await ask("GET", "/events")).status, 401);
    assert.equal((await ask("POST", "/call", origin, { method: "send" })).status, 401);
    assert.equal(await plain("/savi.crt"), 404);
    const code = pairing.start();
    assert.equal(await plain("/savi.crt"), 200);
    assert.equal((await ask("POST", "/pair", { origin: "https://evil.example" }, { code })).status, 403);
    assert.equal((await ask("POST", "/pair", origin, { code: "nope" })).status, 403);
    const paired = await ask("POST", "/pair", origin, { code });
    const set = paired.headers["set-cookie"][0] as string;
    assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/);
    const cookie = set.split(";")[0]!;
    assert.equal((await ask("POST", "/call", { cookie }, { method: "send" })).status, 403, "no origin");
    assert.equal((await ask("POST", "/call", { ...origin, cookie }, { method: "send" })).text, '{"result":"ok"}');
    assert.equal((await ask("POST", "/call", { ...origin, cookie }, "x".repeat(70_000))).status, 400);
    assert.match((await ask("GET", "/events", { cookie })).text, /agenda/);
    store.removeDevice(store.devices()[0]!.id);
    assert.equal((await ask("POST", "/call", { ...origin, cookie }, { method: "send" })).status, 401);
    assert.deepEqual(called, ["send"]);
  } finally {
    await web.update(undefined);
  }
});

test("power: charger, battery and desktop", () => {
  const dir = temp();
  const add = (n: string, o: Record<string, string>) => { mkdirSync(join(dir, n), { recursive: true }); for (const k in o) writeFileSync(join(dir, n, k), o[k]!); };
  assert.equal(pluggedIn(dir), true);
  add("BAT0", { type: "Battery" }); add("AC0", { type: "Mains", online: "0" });
  assert.equal(pluggedIn(dir), false);
  add("AC0", { type: "Mains", online: "1" });
  assert.equal(pluggedIn(dir), true);
});

test("systemd unit escapes paths", () => assert.match(unitText("/a b/code", "/x/50%/$s.cjs"), /ExecStart="\/a b\/code" "\/x\/50%%\/\$\$s\.cjs"/));
