/**
 * Reads the standalone app's configuration file.
 *
 * One YAML file holds three things: the calendars and how to reach them, the locale the card
 * renders in, and the card configuration itself, written exactly as it would be in a Home
 * Assistant dashboard. Credentials stay on the server: a password is named by the environment
 * variable that holds it, never sent to the browser.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { isTimeZone } from './time.js';

export interface IcsCalendarConfig {
  type: 'ics';
  /** Entity-style id the card refers to, `calendar.<name>`. */
  id: string;
  name: string;
  /** The feed's address; `webcal://` is read as `https://`. */
  url: string;
  /** Whether its events get desktop notifications, when they are on. Default true. */
  notify: boolean;
}

export interface CaldavCalendarConfig {
  type: 'caldav';
  id: string;
  name: string;
  /** The CalDAV server's address, for example `https://caldav.fastmail.com/dav/`. */
  server_url: string;
  username: string;
  /** Name of the environment variable holding the password or app password. */
  password_env: string;
  /** The calendar's display name on the server. Matched case-insensitively. */
  calendar: string;
  /** Whether its events get desktop notifications, when they are on. Default true. */
  notify: boolean;
}

export type CalendarConfig = IcsCalendarConfig | CaldavCalendarConfig;

export interface LocaleConfig {
  /** Language code, such as `en` or `de`. */
  language: string;
  /** IANA time zone, such as `Australia/Perth`. */
  time_zone: string;
  /**
   * Whether the file names `time_zone`. When it does not, `time_zone` is the server's own zone,
   * and the page shows times in the zone of the computer it runs on.
   */
  time_zone_set: boolean;
  /** `language`, `12` or `24`, as Home Assistant's profile setting. */
  time_format: string;
  /** `language`, or a weekday name such as `monday`. */
  first_weekday: string;
  /** Two-letter country code, used by the card for holiday-style defaults. */
  country: string | null;
}

/**
 * Desktop notifications for upcoming events. The desktop app shows them; a server running on
 * its own reads these settings but shows nothing.
 */
export interface NotificationConfig {
  enabled: boolean;
  /** How long before a timed event starts to notify, in minutes. 0 is when it starts. */
  minutes_before: number;
  /**
   * When to notify on the day of an all-day event, as `HH:MM` in the configured time zone.
   * Null for no notification.
   */
  all_day_at: string | null;
}

export interface AppConfig {
  port: number;
  /** How long a fetched calendar is served from memory before it is fetched again. */
  refresh_minutes: number;
  locale: LocaleConfig;
  calendars: CalendarConfig[];
  /** The card's own configuration, passed to its `setConfig` unchanged. */
  card: Record<string, unknown>;
  notifications: NotificationConfig;
}

/** Thrown for a configuration the app cannot run with, naming what is wrong. */
export class ConfigError extends Error {}

const ID_PATTERN = /^calendar\.[a-z0-9_]+$/;

/** The longest lead time a notification may have: one day. */
export const MAX_MINUTES_BEFORE = 1440;

const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Loads and checks the configuration file.
 *
 * @param path - Path to the YAML file
 * @returns The configuration with defaults filled in
 */
export function loadConfig(path: string): AppConfig {
  const raw = parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new ConfigError(`${path} is empty or not a mapping`);
  return checkConfig(raw);
}

/**
 * Checks a parsed configuration and fills in defaults.
 *
 * @param raw - The parsed YAML
 * @returns The configuration with defaults filled in
 */
export function checkConfig(raw: Record<string, unknown>): AppConfig {
  const calendars = raw.calendars;
  if (!Array.isArray(calendars) || calendars.length === 0) {
    throw new ConfigError('`calendars` must list at least one calendar');
  }
  const seen = new Set<string>();
  const checked = calendars.map((entry, index) => {
    const calendar = checkCalendar(entry, index);
    if (seen.has(calendar.id)) throw new ConfigError(`calendar id ${calendar.id} is listed twice`);
    seen.add(calendar.id);
    return calendar;
  });

  const locale = (raw.locale ?? {}) as Partial<LocaleConfig>;
  const card = (raw.card ?? {}) as Record<string, unknown>;
  if (typeof card !== 'object' || Array.isArray(card)) {
    throw new ConfigError('`card` must be a mapping');
  }

  if (
    locale.time_zone !== undefined &&
    locale.time_zone !== null &&
    !isTimeZone(locale.time_zone)
  ) {
    throw new ConfigError(
      `locale.time_zone ${locale.time_zone} is not a time zone this system knows`,
    );
  }
  const refresh = Number(raw.refresh_minutes ?? 5);
  if (!Number.isFinite(refresh) || refresh <= 0) {
    throw new ConfigError('`refresh_minutes` must be a number above 0');
  }

  return {
    port: Number(raw.port ?? process.env.PORT ?? 8080),
    refresh_minutes: Number(raw.refresh_minutes ?? 5),
    locale: {
      language: locale.language ?? 'en',
      time_zone: locale.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      time_zone_set: !!locale.time_zone,
      time_format: locale.time_format ?? 'language',
      first_weekday: locale.first_weekday ?? 'language',
      country: locale.country ?? null,
    },
    calendars: checked,
    notifications: checkNotifications(raw.notifications),
    // With no `entities`, the card shows every configured calendar.
    card: {
      ...card,
      entities: card.entities ?? checked.map((calendar) => calendar.id),
    },
  };
}

/**
 * Checks one entry of `calendars`.
 *
 * @param entry - The parsed entry
 * @param index - Its position, for messages
 * @returns The calendar
 */
export function checkCalendar(entry: unknown, index: number): CalendarConfig {
  const where = `calendars[${index}]`;
  if (!entry || typeof entry !== 'object') throw new ConfigError(`${where} must be a mapping`);
  const c = entry as Record<string, unknown>;
  const need = (key: string): string => {
    const value = c[key];
    if (typeof value !== 'string' || value === '') {
      throw new ConfigError(`${where}.${key} is required`);
    }
    return value;
  };
  const id = need('id');
  if (!ID_PATTERN.test(id)) {
    throw new ConfigError(`${where}.id must look like calendar.my_name (got ${id})`);
  }
  const name = typeof c.name === 'string' ? c.name : id.slice('calendar.'.length);

  if (c.notify !== undefined && typeof c.notify !== 'boolean') {
    throw new ConfigError(`${where}.notify must be true or false`);
  }
  const notify = c.notify !== false;

  if (c.type === 'ics') return { type: 'ics', id, name, url: need('url'), notify };
  if (c.type === 'caldav') {
    return {
      type: 'caldav',
      id,
      name,
      server_url: need('server_url'),
      username: need('username'),
      password_env: need('password_env'),
      calendar: need('calendar'),
      notify,
    };
  }
  throw new ConfigError(`${where}.type must be ics or caldav`);
}

/**
 * Checks `notifications`.
 *
 * @param raw - The parsed value, or undefined when the file has none
 * @returns The settings with defaults filled in: off, 10 minutes before, none for all-day events
 */
export function checkNotifications(raw: unknown): NotificationConfig {
  if (raw === undefined || raw === null) {
    return { enabled: false, minutes_before: 10, all_day_at: null };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('`notifications` must be a mapping');
  }
  const n = raw as Record<string, unknown>;
  if (n.enabled !== undefined && typeof n.enabled !== 'boolean') {
    throw new ConfigError('notifications.enabled must be true or false');
  }
  const minutes = Number(n.minutes_before ?? 10);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_MINUTES_BEFORE) {
    throw new ConfigError(
      `notifications.minutes_before must be a whole number from 0 to ${MAX_MINUTES_BEFORE}`,
    );
  }
  const allDay = n.all_day_at ?? null;
  if (allDay !== null && (typeof allDay !== 'string' || !CLOCK_PATTERN.test(allDay))) {
    throw new ConfigError('notifications.all_day_at must be a time such as 09:00');
  }
  return { enabled: n.enabled === true, minutes_before: minutes, all_day_at: allDay };
}
