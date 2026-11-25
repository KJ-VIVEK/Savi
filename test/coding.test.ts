import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCodingTools } from "../src/core/coding.ts";
import { createExpertTool } from "../src/core/expert.ts";
import { findLink, RemoteControl } from "../src/providers/remote-control.ts";

function setup(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "savi-test-")), folder = join(dir, "Demo"), exe = join(dir, "claude");
  mkdirSync(folder);
  writeFileSync(exe, `#!/bin/sh\necho "$PWD|$*|\${ANTHROPIC_API_KEY:-none}" > ${dir}/args\n${script}\n`);
  chmodSync(exe, 0o700);
  return { dir, rc: new RemoteControl({ executable: () => exe, folders: () => [folder], model: () => "", dir }) };
}

test("starts in the listed folder with Sonnet and normal permissions, then stops", async () => {
  const { dir, rc } = setup('echo "visit https://claude.ai/code in a browser"; echo "https://claude.ai/code/session_abc "; exec sleep 30');
  process.env.ANTHROPIC_API_KEY = "k";
  const s = await rc.start("demo").finally(() => delete process.env.ANTHROPIC_API_KEY);
  assert.equal(s.link, "https://claude.ai/code/session_abc");
  assert.match(readFileSync(join(dir, "args"), "utf8"), /Demo\|remote-control --name Savi: Demo .*--permission-mode default\|none/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "coding.json"), "utf8")), { model: "sonnet" });
  assert.equal(await rc.start("Demo"), s);
  await rc.stop("DEMO");
  assert.deepEqual(rc.sessions(), []);
});

test("unlisted folders and paths are refused", async () => {
  const { rc } = setup("exit 0");
  for (const p of ["/etc", "../Demo", "Other"]) await assert.rejects(rc.start(p), /not in/);
});

test("missing consent is explained", async () => {
  const { rc } = setup('echo "Enable Remote Control? (y/n)"; exit 1');
  await assert.rejects(rc.start("Demo"), /consent once/);
  assert.deepEqual(rc.sessions(), []);
});

test("starting and stopping always need approval", () => {
  const effects = createCodingTools({} as never).map((t) => [t.spec.name, t.effect]);
  assert.deepEqual(effects, [["list_coding", "read"], ["start_coding", "modify"], ["stop_coding", "modify"]]);
});

test("the general page is not a session link", () => assert.equal(findLink("visit claude.ai/code or https://claude.ai/code now"), undefined));

test("the expert's answer is returned", async () => {
  const t = createExpertTool(async () => ({ send: async (turn, h) => h.onText?.(`re: ${turn.text}`) }));
  assert.deepEqual(await t.prepare({ question: "q" }).run(), { answer: "re: q" });
});
