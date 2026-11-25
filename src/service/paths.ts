import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir() {
  const dir = process.env.SAVI_DATA ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "savi");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export const socketPath = () => join(dataDir(), "savi.sock");
