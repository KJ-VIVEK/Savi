import type {
  CalendarEvent, Kind, Priority, CalendarService, EventChanges, NewEvent, NewTask, Task, TaskChanges, TaskService,
} from "../core/calendar.ts";
import { addDays, checkRange, isDateOnly, normalizeWhen, timeZone, toLocal } from "../core/time.ts";

const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TASKS = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";

export interface TokenSource { accessToken(forceRefresh?: boolean): Promise<string> }

interface GTime { date?: string | null; dateTime?: string | null; timeZone?: string | null }
interface GEvent {
  id: string; summary?: string; description?: string; location?: string; htmlLink?: string;
  start: GTime; end: GTime; recurringEventId?: string;
  colorId?: string; eventType?: string; extendedProperties?: { private?: Record<string, string> };
}
interface GTask { id: string; title?: string; notes?: string; due?: string }
interface Page<T> { items?: T[]; nextPageToken?: string }

class GoogleClient {
  private auth: TokenSource;
  private fetcher: typeof fetch;

  constructor(auth: TokenSource, fetcher: typeof fetch) {
    this.auth = auth;
    this.fetcher = fetcher;
  }

  async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    let res = await this.send(method, url, body, await this.auth.accessToken());
    if (res.status === 401) res = await this.send(method, url, body, await this.auth.accessToken(true));
    if (!res.ok) {
      const detail = (await res.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
      throw new Error(`Google: ${detail?.error?.message ?? `HTTP ${res.status}`}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async all<T>(url: string, params: Record<string, string>): Promise<T[]> {
    const items: T[] = [];
    let token: string | undefined;
    do {
      const q = new URLSearchParams(token ? { ...params, pageToken: token } : params);
      const page: Page<T> = await this.request("GET", `${url}?${q}`);
      items.push(...(page.items ?? []));
      token = page.nextPageToken;
    } while (token);
    return items;
  }

  private send(method: string, url: string, body: unknown, token: string) {
    return this.fetcher(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  }
}

/** Google's Tomato, Banana and Basil. Recolouring in Google Calendar changes the priority too. */
const COLORS: Record<Priority, string> = { high: "11", medium: "5", low: "10" };
const fromColor = (id?: string) => (Object.keys(COLORS) as Priority[]).find((p) => COLORS[p] === id);

function kindOf(e: GEvent): Kind {
  const kind = e.extendedProperties?.private?.saviKind;
  if (e.eventType === "birthday" || kind === "birthday") return "birthday";
  return kind === "reminder" ? "reminder" : "event";
}

/** Nulls clear the other representation when PATCH switches timed and all-day. */
const toTime = (s: string, zone: string): GTime =>
  isDateOnly(s) ? { date: s, dateTime: null, timeZone: null } : { date: null, dateTime: normalizeWhen(s), timeZone: zone };

const toEnd = (s: string, zone: string) => toTime(isDateOnly(s) ? addDays(s, 1) : s, zone);

const fromTime = (t: GTime) => (t.date ? t.date : toLocal(new Date(t.dateTime!)));

function fromEvent(e: GEvent): CalendarEvent {
  return {
    id: e.id,
    title: e.summary ?? "(no title)",
    start: fromTime(e.start),
    end: e.end.date ? addDays(e.end.date, -1) : fromTime(e.end),
    description: e.description,
    location: e.location,
    url: e.htmlLink,
    recurring: e.recurringEventId ? true : undefined,
    kind: kindOf(e),
    priority: fromColor(e.colorId),
  };
}

const details = (e: EventChanges) => ({
  summary: e.title,
  description: e.description,
  location: e.location,
  colorId: e.priority && COLORS[e.priority],
  reminders: e.reminderMinutes && {
    useDefault: false,
    overrides: e.reminderMinutes.map((minutes) => ({ method: "popup", minutes })),
  },
});

/** Keeps the event's length when only its start moves. */
export function movedEnd(old: CalendarEvent, start: string): string {
  if (isDateOnly(start) !== isDateOnly(old.start))
    throw new Error("Provide an end when switching between timed and all-day.");
  // Wall-clock arithmetic in UTC, so daylight-saving changes do not alter the length.
  const ms = (s: string) => Date.parse(isDateOnly(s) ? `${s}T00:00:00Z` : `${normalizeWhen(s)}Z`);
  return new Date(ms(start) + ms(old.end) - ms(old.start)).toISOString().slice(0, isDateOnly(start) ? 10 : 19);
}

export class GoogleCalendar implements CalendarService {
  private api: GoogleClient;
  constructor(auth: TokenSource, fetcher: typeof fetch = fetch) { this.api = new GoogleClient(auth, fetcher); }

  async listEvents(from: Date, to: Date, query?: string) {
    const items = await this.api.all<GEvent>(CALENDAR, {
      timeMin: from.toISOString(), timeMax: to.toISOString(),
      singleEvents: "true", orderBy: "startTime", maxResults: "250", ...(query ? { q: query } : {}),
    });
    return items.map(fromEvent);
  }

  async getEvent(id: string) { return fromEvent(await this.api.request("GET", this.url(id))); }

  async createEvent(e: NewEvent) {
    checkRange(e.start, e.end);
    const zone = timeZone();
    return fromEvent(await this.api.request("POST", CALENDAR, {
      ...details(e),
      start: toTime(e.start, zone),
      end: toEnd(e.end, zone),
      transparency: e.busy === false ? "transparent" : undefined,
      extendedProperties: { private: { saviKind: e.kind ?? "event" } },
      recurrence: e.recurrence && [`RRULE:${e.recurrence}`],
    }));
  }

  async updateEvent(id: string, c: EventChanges) {
    const times: { start?: GTime; end?: GTime } = {};
    if (c.start || c.end) {
      const old = await this.getEvent(id);
      const start = c.start ?? old.start;
      const end = c.end ?? movedEnd(old, start);
      checkRange(start, end);
      const zone = timeZone();
      times.start = toTime(start, zone);
      times.end = toEnd(end, zone);
    }
    return fromEvent(await this.api.request("PATCH", this.url(id), { ...details(c), ...times }));
  }

  async deleteEvent(id: string) { await this.api.request("DELETE", this.url(id)); }

  private url(id: string) { return `${CALENDAR}/${encodeURIComponent(id)}`; }
}

// Google Tasks has no priority or colour, so priority is the last line of the notes.
const MARK = /(?:^|\n)Priority: (high|medium|low)$/;
const toNotes = (notes?: string, priority?: Priority) => [notes, priority && `Priority: ${priority}`].filter(Boolean).join("\n");

const fromTask = (t: GTask): Task => ({
  id: t.id,
  title: t.title || "(no title)",
  due: t.due?.slice(0, 10),
  notes: t.notes?.replace(MARK, "") || undefined,
  priority: t.notes?.match(MARK)?.[1] as Priority | undefined,
});
const RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const rank = (t: Task) => (t.priority ? RANK[t.priority] : 3);
// Google stores only the date part of a task's due value.
const toDue = (due?: string) => due && `${due}T00:00:00.000Z`;

export class GoogleTasks implements TaskService {
  private api: GoogleClient;
  constructor(auth: TokenSource, fetcher: typeof fetch = fetch) { this.api = new GoogleClient(auth, fetcher); }

  async listTasks() {
    const items = await this.api.all<GTask>(TASKS, { showCompleted: "false", maxResults: "100" });
    return items.map(fromTask).sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || rank(a) - rank(b));
  }

  async getTask(id: string) { return fromTask(await this.api.request("GET", this.url(id))); }

  async createTask(t: NewTask) {
    return fromTask(await this.api.request("POST", TASKS, {
      title: t.title, due: toDue(t.due), notes: toNotes(t.notes, t.priority) || undefined,
    }));
  }

  async updateTask(id: string, { completed, due, title, notes, priority }: TaskChanges) {
    let combined: string | undefined;
    if (notes !== undefined || priority) {
      const old = await this.getTask(id);
      combined = toNotes(notes ?? old.notes, priority ?? old.priority);
    }
    return fromTask(await this.api.request("PATCH", this.url(id), {
      title,
      notes: combined,
      due: toDue(due),
      status: completed === undefined ? undefined : completed ? "completed" : "needsAction",
      completed: completed === false ? null : undefined,
    }));
  }

  async deleteTask(id: string) { await this.api.request("DELETE", this.url(id)); }

  private url(id: string) { return `${TASKS}/${encodeURIComponent(id)}`; }
}
