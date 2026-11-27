/**
 * Notifications for upcoming events.
 *
 * Every half minute the notifier reads the calendars that have notifications on, works out when
 * each event's notification is due, and hands over the ones that have come due. Times are worked
 * out in the configured time zone, so an all-day event's "09:00" is nine in the morning there.
 *
 * The notifier does not show anything itself. In the desktop app (`NOTIFICATIONS=stdout`) it
 * writes each one to standard output as a line the Rust side reads and shows through Tauri's
 * notification plugin. A server running on its own has no notifier.
 */

import type { AppConfig, NotificationConfig } from './config.js';
import { expandCalendar, type HaEvent, type Window } from './ical.js';
import type { CalendarSource } from './sources/source.js';
import { instantOf, wallClockAt } from './time.js';

/** What the desktop app shows. */
export interface Notice {
  title: string;
  body: string;
}

/** One event's notification and when it is due. */
export interface Reminder extends Notice {
  /** Tells occurrences apart, so each is notified once. */
  key: string;
  at: Date;
}

/** How often the notifier looks for notifications that have come due. */
export const TICK_MS = 30_000;

/**
 * How late a notification may still be shown, such as after the computer wakes from sleep or the
 * app starts. Older ones are dropped rather than shown in a burst.
 */
export const GRACE_MS = 10 * 60_000;

/** The prefix of the line the desktop app reads a notification from. */
export const STDOUT_PREFIX = 'CALENDAR_PRO_NOTIFICATION ';

const DAY_MS = 86_400_000;

export interface FormatOptions {
  timeZone: string;
  /** Language code for dates and times. */
  language: string;
  /** `language`, `12` or `24`. */
  timeFormat: string;
  /** Shown under the event's own details. */
  calendarName: string;
}

/**
 * The notifications a calendar's events call for.
 *
 * @param calendarId - The calendar's id, for the keys
 * @param events - Its occurrences, as `expandCalendar` returns them
 * @param settings - The notification settings
 * @param format - Time zone, language and the calendar's name
 * @param now - The current time, to tell whether an event is on another day
 * @returns One reminder per event that gets one, in no particular order
 */
export function remindersFor(
  calendarId: string,
  events: HaEvent[],
  settings: NotificationConfig,
  format: FormatOptions,
  now: Date,
): Reminder[] {
  const out: Reminder[] = [];
  const today = dayOf(now, format.timeZone);
  for (const event of events) {
    const title = event.summary || '(No title)';
    const start = 'dateTime' in event.start ? event.start.dateTime : event.start.date;
    const key = `${calendarId}|${event.uid ?? event.summary}|${start}`;
    let at: Date;
    let when: string;
    if ('dateTime' in event.start) {
      const begins = new Date(event.start.dateTime);
      const ends = 'dateTime' in event.end ? new Date(event.end.dateTime) : begins;
      at = new Date(+begins - settings.minutes_before * 60_000);
      const otherDay = dayOf(begins, format.timeZone) !== today;
      when =
        +ends > +begins
          ? `${clock(begins, format, otherDay)} – ${clock(ends, format, false)}`
          : clock(begins, format, otherDay);
    } else {
      if (!settings.all_day_at) continue;
      const [year, month, day] = event.start.date.split('-').map(Number);
      const [hour, minute] = settings.all_day_at.split(':').map(Number);
      at = instantOf({ year, month, day, hour, minute, second: 0 }, format.timeZone);
      when = 'All day';
    }
    const body = [when, event.location, format.calendarName].filter(Boolean).join('\n');
    out.push({ key, at, title, body });
  }
  return out;
}

/** A date as `YYYY-MM-DD` in a zone, to compare days. */
function dayOf(date: Date, timeZone: string): string {
  const w = wallClockAt(date, timeZone);
  return `${w.year}-${w.month}-${w.day}`;
}

/** A time of day, with the weekday in front when it is not today. */
function clock(date: Date, format: FormatOptions, withWeekday: boolean): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: format.timeZone,
    hour: 'numeric',
    minute: '2-digit',
  };
  if (format.timeFormat === '12') options.hour12 = true;
  if (format.timeFormat === '24') options.hourCycle = 'h23';
  if (withWeekday) options.weekday = 'short';
  try {
    return new Intl.DateTimeFormat(format.language, options).format(date);
  } catch {
    return new Intl.DateTimeFormat('en', options).format(date);
  }
}

/**
 * The window the notifier reads calendars over: from the day before today to three days on, in
 * whole UTC days. It covers the longest lead time and every zone's "today", and only moves once a
 * day, so a CalDAV calendar's cache (kept per window) is reused between ticks.
 *
 * @param now - The current time
 * @returns The window
 */
export function readWindow(now: Date): Window {
  const day = Math.floor(+now / DAY_MS) * DAY_MS;
  return { start: new Date(day - DAY_MS), end: new Date(day + 3 * DAY_MS) };
}

export interface NotifierOptions {
  /** Shows a notification. */
  emit(notice: Notice): void;
  log?: (message: string) => void;
  /** The clock, replaceable for tests. */
  now?: () => Date;
}

/**
 * Looks for notifications that have come due and emits each once.
 */
export class Notifier {
  private config: AppConfig | null = null;
  private sources: CalendarSource[] = [];
  /** Keys already notified, with when they were due, so a key can be forgotten later. */
  private readonly done = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly emit: (notice: Notice) => void;
  private readonly log: (message: string) => void;
  private readonly now: () => Date;

  constructor(options: NotifierOptions) {
    this.emit = options.emit;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => new Date());
  }

  /** Uses a new configuration and its sources from the next tick on. */
  update(config: AppConfig | null, sources: CalendarSource[]): void {
    this.config = config;
    this.sources = sources;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // The timer alone should not keep the process running.
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Shows a sample notification, for the settings page's test button. */
  test(): void {
    this.emit({
      title: 'Calendar Pro',
      body: 'Notifications are working. Upcoming events will appear like this.',
    });
  }

  /** Emits every notification that has come due since the grace period began. */
  async tick(): Promise<void> {
    const config = this.config;
    if (this.running || !config?.notifications.enabled) return;
    this.running = true;
    try {
      const now = this.now();
      const window = readWindow(now);
      const due: Reminder[] = [];
      for (const source of this.sources) {
        const calendar = config.calendars.find((each) => each.id === source.id);
        if (!calendar?.notify) continue;
        let events: HaEvent[];
        try {
          events = expandCalendar(await source.documents(window), window, config.locale.time_zone);
        } catch (error) {
          this.log(`Notifications: could not read ${source.id}: ${(error as Error).message}`);
          continue;
        }
        const format: FormatOptions = {
          timeZone: config.locale.time_zone,
          language: config.locale.language,
          timeFormat: config.locale.time_format,
          calendarName: source.name,
        };
        for (const reminder of remindersFor(source.id, events, config.notifications, format, now)) {
          if (+reminder.at > +now || +reminder.at <= +now - GRACE_MS) continue;
          if (this.done.has(reminder.key)) continue;
          due.push(reminder);
        }
      }
      due.sort((a, b) => +a.at - +b.at);
      for (const reminder of due) {
        this.done.set(reminder.key, +reminder.at);
        this.emit({ title: reminder.title, body: reminder.body });
      }
      // Forget what can no longer come due again.
      for (const [key, at] of this.done) {
        if (at < +now - 2 * DAY_MS) this.done.delete(key);
      }
    } finally {
      this.running = false;
    }
  }
}

/**
 * Writes a notification for the desktop app to show: one line on standard output.
 *
 * @param notice - The notification
 */
export function emitToStdout(notice: Notice): void {
  process.stdout.write(`${STDOUT_PREFIX}${JSON.stringify(notice)}\n`);
}
