const pad = (n: number) => String(n).padStart(2, "0");

export const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export const toDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const toLocal = (d: Date) =>
  `${toDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** Parses as local time; date-only strings become local midnight. */
export const parseLocal = (s: string) => new Date(isDateOnly(s) ? `${s}T00:00:00` : s);

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Rejects malformed values and impossible dates such as 2026-02-30. */
export function isValidWhen(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(s)) return false;
  const full = isDateOnly(s) ? `${s}T00:00:00Z` : `${s.length === 16 ? `${s}:00` : s}Z`;
  const d = new Date(full);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19) === full.slice(0, 19);
}

export const normalizeWhen = (s: string) => (s.length === 16 ? `${s}:00` : s);

export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Throws when the range is inconsistent. All-day ends are inclusive. */
export function checkRange(start: string, end: string): void {
  if (isDateOnly(start) !== isDateOnly(end)) throw new Error("Start and end must both be dates or both be date-times.");
  if (isDateOnly(start) ? end < start : normalizeWhen(end) <= normalizeWhen(start))
    throw new Error("End must be after start.");
}
