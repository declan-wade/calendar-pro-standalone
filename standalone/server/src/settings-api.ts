/**
 * The settings page's API: read the configuration file, check a calendar, save.
 *
 * - `GET /api/settings`: the file as written, where it is, what is wrong with it if anything,
 *   and where each CalDAV password comes from (never the password)
 * - `PUT /api/settings`: `{ config, passwords? }`. Checks the configuration, keeps any typed
 *   passwords in memory, writes the file and applies it without a restart
 * - `POST /api/settings/check`: `{ calendar, password? }`. Reads an ICS feed or logs in to a
 *   CalDAV server, and says what it found
 *
 * These change what the server reads and where it connects, so by default they answer only a
 * browser on the same computer (`SETTINGS_ACCESS=local`). `SETTINGS_ACCESS=any` opens them to
 * every client, for a server behind an authenticating proxy or in Docker; `off` turns them off.
 * Writes must be JSON, which a page on another site cannot send without the server's consent.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkCalendar, checkConfig, ConfigError, type AppConfig } from './config.js';
import { readConfigFile, writeConfigFile } from './config-file.js';
import { passwordFor, passwordSource, setPassword } from './secrets.js';
import { listCalendarNames } from './sources/caldav.js';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 1_000_000;

export type SettingsAccess = 'local' | 'any' | 'off';

export interface SettingsOptions {
  /** Path to config.yaml. */
  configPath: string;
  access: SettingsAccess;
  /** What is wrong with the file the server started with, if anything. */
  startupError: string | null;
  /** Applies a saved configuration. */
  apply(config: AppConfig): void;
  /** The port the server listens on, to tell whether a save needs a restart. */
  listeningPort(): number;
}

/**
 * Reads `SETTINGS_ACCESS`.
 *
 * @param value - The variable's value
 * @returns The access level, `local` when unset or unknown
 */
export function settingsAccess(value: string | undefined): SettingsAccess {
  return value === 'any' || value === 'off' ? value : 'local';
}

/**
 * Builds the settings routes.
 *
 * @param options - Where the file is and how to apply it
 * @returns A handler that answers a settings request and returns true, or returns false for any
 *   other path
 */
export function createSettingsRoutes(options: SettingsOptions) {
  let lastError = options.startupError;

  return async (url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (url.pathname !== '/api/settings' && !url.pathname.startsWith('/api/settings/')) {
      return false;
    }
    if (options.access === 'off') {
      send(res, 403, { message: 'The settings page is turned off (SETTINGS_ACCESS=off).' });
      return true;
    }
    if (options.access === 'local' && !isLocal(req)) {
      send(res, 403, {
        message:
          'The settings page only answers a browser on the same computer as the server. ' +
          'Set SETTINGS_ACCESS=any to allow others, behind a proxy that asks for a login.',
      });
      return true;
    }
    if (req.method !== 'GET' && !isJson(req)) {
      send(res, 415, { message: 'Send JSON' });
      return true;
    }

    if (url.pathname === '/api/settings' && req.method === 'GET') {
      let config: Record<string, unknown> | null = null;
      try {
        config = readConfigFile(options.configPath);
      } catch (error) {
        lastError = (error as Error).message;
      }
      const names = new Set<string>();
      for (const calendar of (config?.calendars as unknown[] | undefined) ?? []) {
        const name = (calendar as { password_env?: unknown })?.password_env;
        if (typeof name === 'string' && name) names.add(name);
      }
      send(res, 200, {
        config,
        path: options.configPath,
        error: lastError,
        passwords: Object.fromEntries([...names].map((name) => [name, passwordSource(name)])),
        server_time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        port: options.listeningPort(),
        port_from_environment: !!process.env.PORT,
      });
      return true;
    }

    if (url.pathname === '/api/settings' && req.method === 'PUT') {
      const body = (await readJson(req)) as {
        config?: Record<string, unknown>;
        passwords?: Record<string, unknown>;
      };
      if (!body?.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
        send(res, 400, { message: '`config` must be a mapping' });
        return true;
      }
      for (const [name, password] of Object.entries(body.passwords ?? {})) {
        if (typeof password === 'string' && password !== '') setPassword(name, password);
      }
      let checked: AppConfig;
      try {
        checked = checkConfig(structuredClone(body.config));
      } catch (error) {
        if (error instanceof ConfigError) {
          send(res, 400, { message: error.message });
          return true;
        }
        throw error;
      }
      writeConfigFile(options.configPath, body.config);
      options.apply(checked);
      lastError = null;
      const port = Number(body.config.port ?? 8080);
      send(res, 200, {
        saved: true,
        restart_needed: !process.env.PORT && port !== options.listeningPort(),
      });
      return true;
    }

    if (url.pathname === '/api/settings/check' && req.method === 'POST') {
      const body = (await readJson(req)) as { calendar?: unknown; password?: unknown };
      send(res, 200, await checkSource(body?.calendar, body?.password));
      return true;
    }

    send(res, 404, { message: 'Not found' });
    return true;
  };
}

interface CheckResult {
  ok: boolean;
  message: string;
  /** For CalDAV, the event calendars the account holds. */
  calendars?: string[];
  /** For an ICS feed, the name the feed gives itself, if any. */
  feed_name?: string;
}

/**
 * Tries a calendar the settings page describes. A CalDAV entry may leave out `calendar`, to list
 * what the account holds.
 */
async function checkSource(entry: unknown, typedPassword: unknown): Promise<CheckResult> {
  const raw = (entry ?? {}) as Record<string, unknown>;
  try {
    if (raw.type === 'ics') {
      const { url } = checkCalendar({ id: 'calendar.check', ...raw, type: 'ics' }, 0) as {
        url: string;
      };
      const response = await fetch(url.replace(/^webcals?:\/\//i, 'https://'), {
        headers: { accept: 'text/calendar, */*;q=0.5' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          ok: false,
          message: `The feed answered ${response.status} ${response.statusText}`,
        };
      }
      const text = await response.text();
      if (!/BEGIN:VCALENDAR/i.test(text)) {
        return { ok: false, message: 'That address does not return an iCalendar feed.' };
      }
      const events = text.match(/^BEGIN:VEVENT/gim)?.length ?? 0;
      const name = /^X-WR-CALNAME:(.*)$/im.exec(text)?.[1]?.trim();
      return {
        ok: true,
        message: `Read the feed: ${events} event${events === 1 ? '' : 's'}.`,
        feed_name: name || undefined,
      };
    }
    if (raw.type === 'caldav') {
      const serverUrl = typeof raw.server_url === 'string' ? raw.server_url : '';
      const username = typeof raw.username === 'string' ? raw.username : '';
      const envName = typeof raw.password_env === 'string' ? raw.password_env : '';
      const password =
        typeof typedPassword === 'string' && typedPassword !== ''
          ? typedPassword
          : envName
            ? passwordFor(envName)
            : undefined;
      if (!serverUrl || !username) {
        return { ok: false, message: 'Enter the server address and user name.' };
      }
      if (!password) return { ok: false, message: 'Enter the password.' };
      const calendars = await listCalendarNames(serverUrl, username, password);
      const wanted = typeof raw.calendar === 'string' ? raw.calendar.trim().toLowerCase() : '';
      if (wanted && !calendars.some((name) => name.trim().toLowerCase() === wanted)) {
        return {
          ok: false,
          message: `Logged in, but there is no calendar named "${String(raw.calendar)}".`,
          calendars,
        };
      }
      return {
        ok: true,
        message: `Logged in: ${calendars.length} calendar${calendars.length === 1 ? '' : 's'}.`,
        calendars,
      };
    }
    return { ok: false, message: 'Choose ICS feed or CalDAV.' };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/** A request from this computer, addressed to it by a loopback name rather than a public one. */
function isLocal(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  const loopback =
    address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
  // A loopback name in Host too, so a page whose site name was pointed at 127.0.0.1 (DNS
  // rebinding) is still refused.
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  return loopback && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]');
}

function isJson(req: IncomingMessage): boolean {
  return /^application\/json\b/i.test(req.headers['content-type'] ?? '');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}
