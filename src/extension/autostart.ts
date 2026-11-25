import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const UNIT = "savi.service";
const file = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", UNIT);
const systemctl = (...args: string[]) => run("systemctl", ["--user", ...args], { timeout: 15_000 });
const quote = (s: string) => `"${s.replace(/[\\"]/g, "\\$&").replaceAll("%", "%%").replaceAll("$", "$$$$")}"`;

export const unitText = (runtime: string, script: string) => `[Unit]
Description=Savi personal assistant
After=graphical-session.target

[Service]
Environment=ELECTRON_RUN_AS_NODE=1
ExecStart=${quote(runtime)} ${quote(script)}
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=graphical-session.target
`;

export const isEnabled = () => existsSync(file());

/** Also refreshes the path after an extension update. */
export async function enable(script: string) {
  const text = unitText(process.execPath, script);
  if (isEnabled() && readFileSync(file(), "utf8") === text) return;
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), text);
  await systemctl("daemon-reload");
  await systemctl("enable", UNIT);
}

export async function disable() {
  if (!isEnabled()) return;
  await systemctl("disable", UNIT);
  rmSync(file(), { force: true });
  await systemctl("daemon-reload");
}

export const start = () => systemctl("restart", UNIT);
