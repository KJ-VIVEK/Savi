import { z } from "zod";
import type { Found, History } from "./history.ts";
import { addDays, parseLocal, toLocal } from "./time.ts";
import { date, tool, type Tool } from "./tools.ts";

const CHARS = 1500;

/** Reading the record. Local times and short texts, to keep results small. */
export function createHistoryTools(history: History): Tool[] {
  const view = (f: Found) =>
    f.kind === "message"
      ? { conversation: f.conversationId, at: toLocal(new Date(f.at)), from: f.role, device: f.source, text: f.text.slice(0, CHARS) }
      : { conversation: f.conversationId, at: toLocal(new Date(f.at)), action: f.tool, device: f.source, summary: f.summary.slice(0, CHARS), outcome: f.outcome === "started" ? "unknown" : f.outcome };
  return [
    tool({
      name: "search_history",
      description:
        "Search everything the user and Savi said before, and every change Savi made, newest first. Use it when the user refers to the past and the answer is not in this conversation. Give text, a date range, or both. Use kind action for questions about what was changed.",
      effect: "read",
      schema: z.strictObject({
        text: z.string().optional().describe("Words to find"),
        from: date.optional(), to: date.optional().describe("Inclusive, YYYY-MM-DD"),
        kind: z.enum(["message", "action"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      run: async ({ from, to, ...q }) =>
        history.search({ ...q, from: from ? parseLocal(from) : undefined, to: to ? parseLocal(addDays(to, 1)) : undefined }).map(view),
    }),
    tool({
      name: "read_conversation",
      description: "Read the latest messages and actions of one past conversation found with search_history.",
      effect: "read",
      schema: z.strictObject({ conversation: z.number().int() }),
      run: async ({ conversation: id }) =>
        [
          ...history.messages(id, 40).map((m) => ({ kind: "message" as const, ...m })),
          ...history.actions(id, 40).map((a) => ({ kind: "action" as const, ...a })),
        ].sort((a, b) => a.at.localeCompare(b.at)).map(view),
    }),
  ];
}
