import type { NewEvent } from "./calendar.ts";
import { checkRange, isDateOnly } from "./time.ts";

export type EventDraft = Omit<NewEvent, "end" | "busy"> & { end?: string };

/** Fills in what each kind implies. Wall-clock arithmetic is done in UTC. */
export function completeEvent(d: EventDraft): NewEvent {
  const kind = d.kind ?? "event";
  const allDay = isDateOnly(d.start);
  if (kind === "birthday" && !allDay) throw new Error("A birthday needs a date without a time.");
  const minutes = kind === "reminder" ? 15 : 60;
  const end =
    d.end ?? (allDay ? d.start : new Date(Date.parse(`${d.start}Z`) + minutes * 60_000).toISOString().slice(0, 19));
  checkRange(d.start, end);
  const event: NewEvent = { ...d, kind, end };
  if (kind !== "event") event.busy = false;
  if (kind === "reminder" && !allDay) event.reminderMinutes ??= [0];
  // The last day of February, so a 29 February birthday appears every year.
  if (kind === "birthday")
    event.recurrence ??= d.start.endsWith("-02-29") ? "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1" : "FREQ=YEARLY";
  return event;
}
