/**
 * The HTTP handler: the calendar API the browser shim calls, and the static web app.
 *
 * The API mirrors the parts of Home Assistant's REST API the card uses, so the browser side
 * can pass requests through unchanged:
 *
 * - `GET /api/config`: the card configuration, locale and calendar list (not in Home Assistant;
 *   the shim builds its `hass` object from it)
 * - `GET /api/calendars`: `[{ entity_id, name }]`, as Home Assistant
 * - `GET /api/calendars/<entity_id>?start=<iso>&end=<iso>`: that calendar's occurrences in the
 *   window, as Home Assistant
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { AppConfig } from './config.js';
import { expandCalendar } from './ical.js';
import type { CalendarSource } from './sources/source.js';

/** Widest window one request may ask for, so a stray request cannot expand decades of events. */
const MAX_WINDOW_DAYS = 400;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export interface AppOptions {
  config: AppConfig;
  sources: CalendarSource[];
  /** Directory holding the built web app. */
  webRoot: string;
  log?: (message: string) => void;
}

export function createHandler(options: AppOptions) {
  const { config, sources, log = () => {} } = options;
  const webRoot = resolve(options.webRoot);
  const byId = new Map(sources.map((source) => [source.id, source]));

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') return sendJson(res, 405, { message: 'Method not allowed' });
        return await routeApi(url, res);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { message: 'Method not allowed' });
      }
      return await serveStatic(url.pathname, req, res);
    } catch (error) {
      log(`${req.method} ${url.pathname} failed: ${(error as Error).message}`);
      if (!res.headersSent) sendJson(res, 502, { message: (error as Error).message });
      else res.end();
    }
  };

  async function routeApi(url: URL, res: ServerResponse): Promise<void> {
    if (url.pathname === '/api/config') {
      return sendJson(res, 200, {
        locale: config.locale,
        card: config.card,
        calendars: sources.map((source) => ({
          entity_id: source.id,
          name: source.name,
          // Home Assistant's CalendarEntityFeature bits; 0 until the backend can write.
          supported_features: 0,
        })),
      });
    }
    if (url.pathname === '/api/calendars') {
      return sendJson(
        res,
        200,
        sources.map((source) => ({ entity_id: source.id, name: source.name })),
      );
    }
    const match = /^\/api\/calendars\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const source = byId.get(decodeURIComponent(match[1]));
      if (!source) return sendJson(res, 404, { message: `Unknown calendar ${match[1]}` });
      const start = new Date(url.searchParams.get('start') ?? '');
      const end = new Date(url.searchParams.get('end') ?? '');
      if (Number.isNaN(+start) || Number.isNaN(+end) || end <= start) {
        return sendJson(res, 400, { message: 'start and end must be ISO times, start before end' });
      }
      if (+end - +start > MAX_WINDOW_DAYS * 86_400_000) {
        return sendJson(res, 400, { message: `Window is longer than ${MAX_WINDOW_DAYS} days` });
      }
      const documents = await source.documents({ start, end });
      return sendJson(res, 200, expandCalendar(documents, { start, end }, config.locale.time_zone));
    }
    return sendJson(res, 404, { message: 'Not found' });
  }

  async function serveStatic(
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    let file = join(webRoot, relative);
    if (file !== webRoot && !file.startsWith(webRoot + sep)) return sendJson(res, 404, {});
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) return sendJson(res, 404, { message: 'Not found' });
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file).pipe(res);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}
