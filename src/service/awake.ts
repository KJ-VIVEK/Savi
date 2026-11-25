import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const POWER = "/sys/class/power_supply";

/** A desktop without a battery counts as plugged in. */
export function pluggedIn(dir = POWER): boolean {
  const read = (n: string, f: string) => {
    try { return readFileSync(join(dir, n, f), "utf8").trim(); } catch { return ""; }
  };
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { /* none */ }
  if (names.some((n) => read(n, "type") !== "Battery" && read(n, "online") === "1")) return true;
  return !names.some((n) => read(n, "type") === "Battery" && read(n, "scope") !== "Device");
}

/** Holds off automatic sleep while plugged in. Sleeping by hand and closing the lid still work. */
export class Awake {
  private holder?: ChildProcess;
  private retryAt = 0;

  update(wanted: boolean) {
    if (!wanted || !pluggedIn()) {
      this.release();
    } else if (!this.holder && Date.now() >= this.retryAt) {
      // cat ends when our end of the pipe closes, even if Savi crashes.
      const child = spawn("kde-inhibit", ["--power", "cat"], { stdio: ["pipe", "ignore", "ignore"] });
      const gone = () => {
        if (this.holder !== child) return;
        this.holder = undefined;
        this.retryAt = Date.now() + 5 * 60_000;
      };
      child.on("error", gone);
      child.on("exit", gone);
      child.stdin!.on("error", () => {});
      this.holder = child;
    }
  }

  release() {
    const child = this.holder;
    this.holder = undefined;
    child?.stdin?.end();
    child?.kill();
  }
}
