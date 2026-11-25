import type { CalendarEvent, CalendarService, TaskService } from "../src/core/calendar.ts";

export const event: CalendarEvent = { id: "e1", title: "Standup", start: "2026-11-26T09:00:00", end: "2026-11-26T09:30:00", kind: "event" };

export function fakes() {
  const calls: string[] = [];
  const log = <T>(name: string, value: T) => async (...args: unknown[]) => {
    calls.push(`${name} ${JSON.stringify(args)}`);
    return value;
  };
  const calendar: CalendarService = {
    listEvents: log("listEvents", [event]), getEvent: log("getEvent", event), createEvent: log("createEvent", event),
    updateEvent: log("updateEvent", event), deleteEvent: log("deleteEvent", undefined),
  };
  const task = { id: "t1", title: "Pay rent" };
  const tasks: TaskService = {
    listTasks: log("listTasks", [task]), getTask: log("getTask", task), createTask: log("createTask", task),
    updateTask: log("updateTask", task), deleteTask: log("deleteTask", undefined),
  };
  return { calls, calendar, tasks };
}
