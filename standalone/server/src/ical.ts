/**
 * Turns iCalendar text into the events Home Assistant's calendar API returns.
 *
 * The card reads `GET /api/calendars/<entity>?start&end` from Home Assistant, which answers with
 * every occurrence in the window, recurring events already expanded. This module does the same
 * for iCalendar data from an ICS feed or a CalDAV server.
 */

import ICAL from 'ical.js';
import { instantOf, isoDate, isoInZone, isTimeZone, type WallClock } from './time.js';

/** One event as Home Assistant's REST calendar endpoint returns it. */
export interface HaEvent {
  start: { date: string } | { dateTime: string };
  end: { date: string } | { dateTime: string };
  summary: string;
  description: string | null;
  location: string | null;
  uid: string | null;
  recurrence_id: string | null;
  rrule: string | null;
}

export interface Window {
  start: Date;
  end: Date;
}

/** Stops a runaway rule, such as a secondly repeat with no end. */
const MAX_ITERATIONS = 50_000;

type IcalTime = InstanceType<typeof ICAL.Time>;
type IcalComponent = InstanceType<typeof ICAL.Component>;

/**
 * Every occurrence in a window, from one or more iCalendar documents.
 *
 * @param documents - iCalendar texts (one ICS feed, or one per CalDAV object)
 * @param window - Half-open window; an event is kept when it overlaps it
 * @param timeZone - Zone for floating times, all-day boundaries and the output offsets
 * @returns Occurrences sorted by start
 */
export function expandCalendar(documents: string[], window: Window, timeZone: string): HaEvent[] {
  const events: HaEvent[] = [];
  for (const text of documents) {
    let root: IcalComponent;
    try {
      root = new ICAL.Component(ICAL.parse(text));
    } catch {
      // One unreadable object should not take the rest of the calendar with it.
      continue;
    }
    registerZones(root);
    events.push(...expandComponent(root, window, timeZone));
  }
  return events.sort((a, b) => sortKey(a, timeZone) - sortKey(b, timeZone));
}

/**
 * Registers the document's VTIMEZONE definitions that `Intl` does not know by name, such as
 * the Windows zone names some Microsoft servers write.
 */
function registerZones(root: IcalComponent): void {
  for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
    const tzid = vtimezone.getFirstPropertyValue('tzid');
    if (typeof tzid !== 'string' || isTimeZone(tzid) || ICAL.TimezoneService.has(tzid)) continue;
    ICAL.TimezoneService.register(vtimezone);
  }
}

function expandComponent(root: IcalComponent, window: Window, timeZone: string): HaEvent[] {
  const vevents = root.getAllSubcomponents('vevent');
  const masters = new Map<string, IcalComponent>();
  const overrides: IcalComponent[] = [];
  for (const vevent of vevents) {
    if (vevent.hasProperty('recurrence-id')) overrides.push(vevent);
    else masters.set(String(vevent.getFirstPropertyValue('uid') ?? ''), vevent);
  }

  const out: HaEvent[] = [];
  const related = new Set<IcalComponent>();
  for (const [uid, master] of masters) {
    const event = new ICAL.Event(master);
    for (const override of overrides) {
      if (String(override.getFirstPropertyValue('uid') ?? '') === uid) {
        event.relateException(override);
        related.add(override);
      }
    }
    if (event.isRecurring()) out.push(...expandRecurring(event, window, timeZone));
    else pushIfOverlapping(out, event, event.startDate, event.endDate, null, window, timeZone);
  }

  // An override whose series is not in this document, as a CalDAV server can return when only
  // the changed occurrence falls in the requested range: shown as the single event it is.
  for (const override of overrides) {
    if (related.has(override)) continue;
    const event = new ICAL.Event(override);
    const recurrenceId = event.recurrenceId ? icalString(event.recurrenceId) : null;
    pushIfOverlapping(out, event, event.startDate, event.endDate, recurrenceId, window, timeZone);
  }
  return out;
}

function expandRecurring(
  event: InstanceType<typeof ICAL.Event>,
  window: Window,
  timeZone: string,
): HaEvent[] {
  const out: HaEvent[] = [];
  // The iterator's occurrence times drop the series' TZID where no VTIMEZONE defines it, so it
  // is passed along with them.
  const seriesZone = tzidOf(event.startDate);
  const iterator = event.iterator();
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const next = iterator.next();
    if (!next) break;
    const details = event.getOccurrenceDetails(next);
    const start = toInstant(details.startDate, timeZone, seriesZone);
    if (start >= window.end) {
      // An occurrence moved earlier by an override can still land in the window, but the
      // series' own dates run in order, so nothing later in it can.
      break;
    }
    pushIfOverlapping(
      out,
      details.item,
      details.startDate,
      details.endDate,
      icalString(details.recurrenceId),
      window,
      timeZone,
      seriesZone,
    );
  }
  return out;
}

function pushIfOverlapping(
  out: HaEvent[],
  item: InstanceType<typeof ICAL.Event>,
  startTime: IcalTime,
  endTime: IcalTime | null,
  recurrenceId: string | null,
  window: Window,
  timeZone: string,
  seriesZone?: string,
): void {
  if (!startTime) return;
  const allDay = startTime.isDate;
  // An all-day event with no end lasts one day; a timed one with no end is an instant.
  const end = endTime ?? (allDay ? addDays(startTime, 1) : startTime);
  const startInstant = toInstant(startTime, timeZone, seriesZone);
  const endInstant = toInstant(end, timeZone, seriesZone);
  const overlaps =
    startInstant < window.end &&
    (endInstant > window.start || (+endInstant === +startInstant && startInstant >= window.start));
  if (!overlaps) return;

  const status = item.component.getFirstPropertyValue('status');
  if (typeof status === 'string' && status.toUpperCase() === 'CANCELLED') return;

  const rrule = item.component.getFirstPropertyValue('rrule');
  out.push({
    start: allDay
      ? { date: isoDate(startTime.year, startTime.month, startTime.day) }
      : { dateTime: isoInZone(startInstant, timeZone) },
    end: allDay
      ? { date: isoDate(end.year, end.month, end.day) }
      : { dateTime: isoInZone(endInstant, timeZone) },
    summary: item.summary ?? '',
    description: item.description || null,
    location: item.location || null,
    uid: item.uid || null,
    recurrence_id: recurrenceId,
    rrule: rrule ? String(rrule.toString()) : null,
  });
}

/**
 * A time's TZID. Where no VTIMEZONE defines it, ical.js marks the time floating and keeps the
 * name only as `timezone`, so that is read too.
 *
 * @param time - The time as ical.js read it
 * @returns The zone's name, `UTC`, or undefined for a floating time
 */
function tzidOf(time: IcalTime): string | undefined {
  const zone = time.zone?.tzid;
  if (zone && zone !== 'floating') return zone;
  return (time as unknown as { timezone?: string }).timezone || undefined;
}

function addDays(time: IcalTime, days: number): IcalTime {
  const copy = time.clone();
  copy.adjust(days, 0, 0, 0);
  return copy;
}

/**
 * The instant an iCalendar time names.
 *
 * A UTC time is read as UTC; a time with a TZID `Intl` knows is read in that zone; a TZID that
 * only the document's VTIMEZONE defines is read through ical.js; a floating time, or a date, is
 * read in the configured zone.
 *
 * @param time - The time as ical.js read it
 * @param timeZone - The configured zone
 * @param seriesZone - The series' TZID, for an occurrence time that has lost its own
 */
function toInstant(time: IcalTime, timeZone: string, seriesZone?: string): Date {
  const wall: WallClock = {
    year: time.year,
    month: time.month,
    day: time.day,
    hour: time.isDate ? 0 : time.hour,
    minute: time.isDate ? 0 : time.minute,
    second: time.isDate ? 0 : time.second,
  };
  if (time.isDate) return instantOf(wall, timeZone);
  const tzid = tzidOf(time) ?? seriesZone;
  if (tzid === 'UTC' || tzid === 'Z' || time.zone === ICAL.Timezone.utcTimezone) {
    return new Date(
      Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second),
    );
  }
  if (tzid && tzid !== 'floating' && isTimeZone(tzid)) return instantOf(wall, tzid);
  if (tzid && ICAL.TimezoneService.has(tzid)) {
    const zone = ICAL.TimezoneService.get(tzid)!;
    const offsetSeconds = zone.utcOffset(time);
    return new Date(
      Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) -
        offsetSeconds * 1000,
    );
  }
  return instantOf(wall, timeZone);
}

/** An iCalendar time in its basic form, `20261126T093000` or `20261126`, as Home Assistant's `recurrence_id`. */
function icalString(time: IcalTime | null | undefined): string | null {
  if (!time) return null;
  const date = isoDate(time.year, time.month, time.day).replace(/-/g, '');
  if (time.isDate) return date;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date}T${pad(time.hour)}${pad(time.minute)}${pad(time.second)}`;
}

function sortKey(event: HaEvent, timeZone: string): number {
  if ('dateTime' in event.start) return Date.parse(event.start.dateTime);
  const [y, m, d] = event.start.date.split('-').map(Number);
  return +instantOf({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, timeZone);
}
