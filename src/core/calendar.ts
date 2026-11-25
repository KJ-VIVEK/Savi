/**
 * A date is "YYYY-MM-DD" (all day). A date-time is local wall-clock
 * "YYYY-MM-DDTHH:mm:ss" in the calendar's time zone. All-day ends are inclusive.
 */
export const KINDS = ["event", "reminder", "birthday"] as const;
export type Kind = (typeof KINDS)[number];
export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  url?: string;
  recurring?: boolean;
  kind: Kind;
  priority?: Priority;
}

export interface NewEvent {
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  /** RFC 5545 rule without the "RRULE:" prefix, e.g. FREQ=WEEKLY;BYDAY=MO */
  recurrence?: string;
  reminderMinutes?: number[];
  kind?: Kind;
  priority?: Priority;
  /** False leaves the time shown as free. */
  busy?: boolean;
}

export type EventChanges = Partial<Omit<NewEvent, "recurrence" | "kind" | "busy">>;

export interface Task { id: string; title: string; due?: string; notes?: string; priority?: Priority }
export interface NewTask { title: string; due?: string; notes?: string; priority?: Priority }
export interface TaskChanges { title?: string; due?: string; notes?: string; priority?: Priority; completed?: boolean }

export interface CalendarService {
  /** Events overlapping [from, to). */
  listEvents(from: Date, to: Date, query?: string): Promise<CalendarEvent[]>;
  getEvent(id: string): Promise<CalendarEvent>;
  createEvent(event: NewEvent): Promise<CalendarEvent>;
  updateEvent(id: string, changes: EventChanges): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;
}

export interface TaskService {
  /** Open tasks. */
  listTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  createTask(task: NewTask): Promise<Task>;
  updateTask(id: string, changes: TaskChanges): Promise<Task>;
  deleteTask(id: string): Promise<void>;
}
