import { spawn } from "node:child_process";
import type { SecretStore } from "./google-auth.ts";

/** The desktop keyring (KWallet, GNOME Keyring) through libsecret's secret-tool. */
export class Keyring implements SecretStore {
  private service: string;
  constructor(service = "savi") { this.service = service; }

  async get(key: string) {
    const { code, out, err } = await this.tool(["lookup", "service", this.service, "key", key]);
    if (code === 0) return out;
    if (err.trim()) throw new Error(`Keyring: ${err.trim()}`);
    return undefined; // not found is a silent failure
  }

  async store(key: string, value: string) {
    const { code, err } = await this.tool(["store", `--label=Savi ${key}`, "service", this.service, "key", key], value);
    if (code !== 0) throw new Error(`Keyring: ${err.trim() || "could not save"}`);
  }

  async delete(key: string) {
    await this.tool(["clear", "service", this.service, "key", key]);
  }

  /** Secrets travel over stdin, never on the command line. */
  private tool(args: string[], input = "") {
    return new Promise<{ code: number | null; out: string; err: string }>((ok, no) => {
      const child = spawn("secret-tool", args, { stdio: "pipe" });
      let out = "", err = "";
      child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
      child.stderr.setEncoding("utf8").on("data", (d) => (err += d));
      child.on("error", () => no(new Error("secret-tool is missing. Install the libsecret package.")));
      child.on("close", (code) => ok({ code, out, err }));
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }
}
