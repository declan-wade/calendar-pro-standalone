/**
 * A calendar on a CalDAV server, such as Fastmail, iCloud, Nextcloud or Radicale. Read-only for
 * now; writes come with the backend's write endpoints.
 */

import { createDAVClient, type DAVCalendar } from 'tsdav';
import type { CaldavCalendarConfig } from '../config.js';
import type { Window } from '../ical.js';
import { passwordFor } from '../secrets.js';
import { TimedCache, type CalendarSource } from './source.js';

type DAVClient = Awaited<ReturnType<typeof createDAVClient>>;

export class CaldavSource implements CalendarSource {
  readonly id: string;
  readonly name: string;
  private readonly config: CaldavCalendarConfig;
  private readonly cache: TimedCache<string[]>;
  private connection: Promise<{ client: DAVClient; calendar: DAVCalendar }> | null = null;

  constructor(config: CaldavCalendarConfig, refreshMinutes: number) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    this.cache = new TimedCache(refreshMinutes * 60_000);
  }

  documents(window: Window): Promise<string[]> {
    const key = `${window.start.toISOString()}/${window.end.toISOString()}`;
    return this.cache.get(key, async () => {
      const { client, calendar } = await this.connect();
      const objects = await client.fetchCalendarObjects({
        calendar,
        timeRange: { start: window.start.toISOString(), end: window.end.toISOString() },
      });
      return objects.map((object) => object.data).filter((data): data is string => !!data);
    });
  }

  /** Logs in and finds the configured calendar once, then reuses it. */
  private connect(): Promise<{ client: DAVClient; calendar: DAVCalendar }> {
    if (!this.connection) {
      this.connection = this.openConnection();
      // A failed login is retried on the next request rather than remembered.
      this.connection.catch(() => {
        this.connection = null;
      });
    }
    return this.connection;
  }

  private async openConnection(): Promise<{ client: DAVClient; calendar: DAVCalendar }> {
    const password = passwordFor(this.config.password_env);
    if (!password) {
      throw new Error(`${this.id}: environment variable ${this.config.password_env} is not set`);
    }
    const { client, calendars } = await logIn(
      this.config.server_url,
      this.config.username,
      password,
    );
    const wanted = this.config.calendar.trim().toLowerCase();
    const calendar = calendars.find((c) => displayName(c).trim().toLowerCase() === wanted);
    if (!calendar) {
      const names = calendars.map(displayName).join(', ');
      throw new Error(`${this.id}: no calendar named "${this.config.calendar}" (found: ${names})`);
    }
    return { client, calendar };
  }
}

/**
 * Logs in to a CalDAV server and lists its calendars.
 *
 * @param serverUrl - The server's address
 * @param username - Account name
 * @param password - Password or app password
 * @returns The client and the account's calendars
 */
async function logIn(
  serverUrl: string,
  username: string,
  password: string,
): Promise<{ client: DAVClient; calendars: DAVCalendar[] }> {
  const client = await createDAVClient({
    serverUrl,
    credentials: { username, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
  return { client, calendars: await client.fetchCalendars() };
}

/**
 * The names of the event calendars an account holds, for the settings page to offer.
 *
 * @param serverUrl - The server's address
 * @param username - Account name
 * @param password - Password or app password
 * @returns Display names, in the server's order
 */
export async function listCalendarNames(
  serverUrl: string,
  username: string,
  password: string,
): Promise<string[]> {
  const { calendars } = await logIn(serverUrl, username, password);
  return calendars
    .filter((calendar) => !calendar.components || calendar.components.includes('VEVENT'))
    .map(displayName);
}

function displayName(calendar: DAVCalendar): string {
  const name = calendar.displayName;
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object' && '_cdata' in name) return String(name._cdata);
  return calendar.url;
}
