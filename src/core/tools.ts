import { z } from "zod";
import { type CalendarService, KINDS, PRIORITIES, type TaskService } from "./calendar.ts";
import { completeEvent } from "./draft.ts";
import type { ToolSpec } from "./llm.ts";
import { addDays, isDateOnly, isValidWhen, normalizeWhen, parseLocal } from "./time.ts";

export type Effect = "read" | "create" | "modify";

export interface Tool {
  spec: ToolSpec;
  /** The same schema as zod fields, for hosts that register tools that way. */
  shape: z.ZodRawShape;
  effect: Effect;
  /** Validates input, then returns what would happen and how to do it. */
  prepare(input: unknown): Prepared;
}

export interface Prepared {
  /** Shown to the user for approval; looks items up so IDs never appear. */
  describe(): Promise<string>;
  run(): Promise<unknown>;
}

export function tool<S extends z.ZodObject>(def: {
  name: string;
  description: string;
  effect: Effect;
  schema: S;
  describe?: (input: z.output<S>) => string | Promise<string>;
  run: (input: z.output<S>) => Promise<unknown>;
}): Tool {
  const { $schema: _, ...schema } = z.toJSONSchema(def.schema, { io: "input" });
  return {
    spec: { name: def.name, description: def.description, schema },
    shape: def.schema.shape,
    effect: def.effect,
    prepare(raw) {
      const parsed = def.schema.safeParse(raw);
      if (!parsed.success) throw new Error(`Invalid input: ${z.prettifyError(parsed.error)}`);
      const input = parsed.data;
      return {
        describe: async () => (def.describe ? def.describe(input) : def.name),
        run: () => def.run(input),
      };
    },
  };
}

const when = z
  .string()
  .refine(isValidWhen, "Use YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss")
  .describe("YYYY-MM-DD for all-day, or local YYYY-MM-DDTHH:mm:ss without an offset")
  .overwrite(normalizeWhen);
export const date = z
  .string()
  .refine((s) => isDateOnly(s) && isValidWhen(s), "Use YYYY-MM-DD")
  .describe("YYYY-MM-DD");
const id = z.string().min(1);
const title = z.string().min(1);
const text = z.string().optional();
const reminders = z
  .array(z.number().int().min(0).max(40320))
  .max(5)
  .optional()
  .describe("Popup reminders, in minutes before the start");

const priority = z.enum(PRIORITIES).optional().describe("Shown as a colour: high red, medium yellow, low green");

const span = (e: { start: string; end: string }) => `${e.start.replace("T", " ")} to ${e.end.replace("T", " ")}`;
const changes = (o: Record<string, unknown>) =>
  Object.entries(o)
    .filter(([k, v]) => k !== "id" && v !== undefined)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
    .join("\n");

export function createTools(calendar: CalendarService, tasks: TaskService): Tool[] {
  return [
    tool({
      name: "list_events",
      description:
        "List calendar events. Both dates are inclusive. Recurring events are expanded, so each result is one occurrence. Use it to find event IDs and to check for conflicts.",
      effect: "read",
      schema: z.strictObject({ from: date, to: date, query: z.string().optional().describe("Free-text filter") }),
      run: async ({ from, to, query }) => {
        if (to < from) throw new Error("'to' must not be before 'from'.");
        return calendar.listEvents(parseLocal(from), parseLocal(addDays(to, 1)), query);
      },
    }),
    tool({
      name: "create_event",
      description:
        "Create a calendar entry. Kinds: event (meeting, appointment, trip), reminder (a nudge at a time; pops up at the start), birthday (a date; repeats yearly by itself). For all-day entries use dates; the end date is inclusive. End may be omitted: events last an hour, or one day if all-day.",
      effect: "create",
      schema: z.strictObject({
        kind: z.enum(KINDS), priority,
        title, start: when, end: when.optional(), description: text, location: text, reminderMinutes: reminders,
        recurrence: z.string().regex(/^FREQ=[A-Z0-9=;,:+-]+$/).optional()
          .describe("RFC 5545 rule without the RRULE: prefix, e.g. FREQ=WEEKLY;BYDAY=MO"),
      }),
      describe: (e) => `Create event\n${changes(e)}`,
      run: async (e) => calendar.createEvent(completeEvent(e)),
    }),
    tool({
      name: "update_event",
      description:
        "Change an event. Send only fields that change. Sending start without end keeps the duration. For a recurring event this changes only that occurrence.",
      effect: "modify",
      schema: z.strictObject({
        id, priority, title: title.optional(), start: when.optional(), end: when.optional(),
        description: text, location: text, reminderMinutes: reminders,
      }),
      describe: async (c) => {
        const e = await calendar.getEvent(c.id);
        return `Change "${e.title}" (${span(e)})\n${changes(c)}`;
      },
      run: ({ id, ...c }) => calendar.updateEvent(id, c),
    }),
    tool({
      name: "delete_event",
      description: "Delete an event. For a recurring event this deletes only that occurrence.",
      effect: "modify",
      schema: z.strictObject({ id }),
      describe: async ({ id }) => {
        const e = await calendar.getEvent(id);
        return `Delete "${e.title}" (${span(e)})`;
      },
      run: async ({ id }) => {
        await calendar.deleteEvent(id);
        return { deleted: true };
      },
    }),
    tool({
      name: "list_tasks",
      description: "List open to-do tasks.",
      effect: "read",
      schema: z.strictObject({}),
      run: () => tasks.listTasks(),
    }),
    tool({
      name: "create_task",
      description:
        "Create a to-do task. The due value is a date only; if the user wants a specific time, create a reminder instead.",
      effect: "create",
      schema: z.strictObject({ title, priority, due: date.optional(), notes: text }),
      describe: (t) => `Create task\n${changes(t)}`,
      run: (t) => tasks.createTask(t),
    }),
    tool({
      name: "update_task",
      description: "Change a task or mark it completed. Send only fields that change.",
      effect: "modify",
      schema: z.strictObject({
        id, priority, title: title.optional(), due: date.optional(), notes: text, completed: z.boolean().optional(),
      }),
      describe: async (c) => `Change task "${(await tasks.getTask(c.id)).title}"\n${changes(c)}`,
      run: ({ id, ...c }) => tasks.updateTask(id, c),
    }),
    tool({
      name: "delete_task",
      description: "Delete a task permanently. To finish a task, use update_task with completed instead.",
      effect: "modify",
      schema: z.strictObject({ id }),
      describe: async ({ id }) => `Delete task "${(await tasks.getTask(id)).title}"`,
      run: async ({ id }) => {
        await tasks.deleteTask(id);
        return { deleted: true };
      },
    }),
  ];
}
