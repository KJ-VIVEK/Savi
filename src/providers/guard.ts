import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Ruling = { allow: true } | { deny: string } | { ask: string; edit: boolean };

const READS = new Set(["Read", "Glob", "Grep"]);
const EDITS = new Set(["Edit", "Write"]);
export const CODING_TOOLS = [...READS, ...EDITS, "Bash"];

/** Follows links, including in the parents of a file that does not exist yet. */
function real(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(real(parent), basename(path));
}

/** Decides one tool call in a project. Anything not recognised is refused. */
export function rule(toolName: string, input: Record<string, unknown>, folder: string): Ruling {
  const root = realpathSync(folder);
  if (READS.has(toolName) || EDITS.has(toolName)) {
    const given = input.file_path ?? input.path ?? root;
    if (typeof given !== "string") return { deny: "Invalid path." };
    const full = real(resolve(root, given));
    const inside = relative(root, full);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { deny: "That is outside the connected project." };
    // Glob patterns could climb out by themselves.
    for (const p of [input.pattern, input.glob])
      if (toolName !== "Read" && typeof p === "string" && (toolName === "Glob" || p === input.glob) && (isAbsolute(p) || p.split(/[\\/]/).includes("..")))
        return { deny: "Patterns must stay inside the project." };
    if (READS.has(toolName)) return { allow: true };
    // These run code by themselves later, outside any approval.
    if (inside.split(sep).some((s) => s === ".git" || s === ".claude" || s === ".vscode"))
      return { deny: "Savi does not edit .git, .claude or .vscode folders." };
    const body = toolName === "Write"
      ? `New content:\n${String(input.content ?? "")}`
      : `Replace${input.replace_all ? " everywhere" : ""}:\n${String(input.old_string ?? "")}\n\nWith:\n${String(input.new_string ?? "")}`;
    return { ask: `${toolName === "Write" ? "Write" : "Edit"} ${inside}\n${body}`, edit: true };
  }
  if (toolName === "Bash") {
    const command = input.command;
    if (typeof command !== "string" || !command.trim()) return { deny: "Invalid command." };
    if (input.run_in_background) return { deny: "Background commands are not allowed." };
    if (/(^|[^\w.-])(sudo|su|doas|pkexec|run0)([^\w.-]|$)/.test(command)) return { deny: "Administrator commands are not allowed." };
    // Characters that could make the shown text differ from what runs.
    if (/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(command)) return { deny: "The command has hidden characters." };
    return { ask: `Run a command\n${command}`, edit: false };
  }
  return { deny: "Not available in a connected project." };
}
