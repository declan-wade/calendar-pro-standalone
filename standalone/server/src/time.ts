/**
 * Wall-clock time in a named time zone, without a date library.
 *
 * The card expects Home Assistant's event shape, where a timed event's `dateTime` carries the
 * offset of the calendar's zone. These helpers turn a wall-clock time in an IANA zone into an
 * instant and back, using only `Intl`.
 */

export interface WallClock {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/**
 * Whether a name is an IANA time zone this runtime knows.
 *
 * @param timeZone - Candidate name
 * @returns True if `Intl` accepts it
 */
export function isTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The wall clock in a zone at an instant.
 *
 * @param date - The instant
 * @param timeZone - IANA zone
 * @returns Its wall-clock fields
 */
export function wallClockAt(date: Date, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/**
 * The zone's offset from UTC at an instant, in minutes.
 *
 * @param date - The instant
 * @param timeZone - IANA zone
 * @returns Minutes east of UTC
 */
export function offsetMinutes(date: Date, timeZone: string): number {
  const w = wallClockAt(date, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/**
 * The instant a wall-clock time in a zone names.
 *
 * A time skipped by a clock change resolves to the instant after the gap; a repeated time
 * resolves to its first occurrence.
 *
 * @param wall - Wall-clock fields
 * @param timeZone - IANA zone
 * @returns The instant
 */
export function instantOf(wall: WallClock, timeZone: string): Date {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // Two passes settle the offset on either side of a clock change.
  let guess = asUtc - offsetMinutes(new Date(asUtc), timeZone) * 60000;
  guess = asUtc - offsetMinutes(new Date(guess), timeZone) * 60000;
  return new Date(guess);
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/**
 * ISO 8601 with the zone's offset, as Home Assistant writes `dateTime`.
 *
 * @param date - The instant
 * @param timeZone - IANA zone
 * @returns For example `2026-11-26T09:30:00+08:00`
 */
export function isoInZone(date: Date, timeZone: string): string {
  const w = wallClockAt(date, timeZone);
  const offset = offsetMinutes(date, timeZone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * A calendar date as `YYYY-MM-DD`.
 *
 * @param year - Year
 * @param month - 1 to 12
 * @param day - Day of month
 * @returns The date string
 */
export function isoDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}
