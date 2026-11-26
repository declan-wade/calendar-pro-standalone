/**
 * Entry point: reads the configuration and serves the app.
 *
 * Environment:
 * - `CONFIG`: path to the YAML configuration (default `config.yaml` in the working directory)
 * - `WEB_ROOT`: directory of the built web app (default `web/dist` beside `server/`)
 * - `PORT`: overrides `port` in the configuration
 * - `HOST`: address to listen on (default every interface); the desktop app sets `127.0.0.1`
 * - `EXIT_WITH_STDIN`: when set, exit once standard input closes. The desktop app sets it, so the
 *   backend stops even when the app is killed rather than quit.
 */

import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { CaldavSource } from './sources/caldav.js';
import { IcsSource } from './sources/ics.js';
import type { CalendarSource } from './sources/source.js';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(process.env.CONFIG ?? 'config.yaml');
const webRoot = resolve(process.env.WEB_ROOT ?? join(here, '..', '..', 'web', 'dist'));

let config;
try {
  config = loadConfig(configPath);
} catch (error) {
  const reason = error instanceof ConfigError ? error.message : (error as Error).message;
  console.error(`Cannot start: ${configPath}: ${reason}`);
  process.exit(1);
}
if (process.env.PORT) config.port = Number(process.env.PORT);

const sources: CalendarSource[] = config.calendars.map((calendar) =>
  calendar.type === 'ics'
    ? new IcsSource(calendar, config.refresh_minutes)
    : new CaldavSource(calendar, config.refresh_minutes),
);

const log = (message: string): void => console.log(`${new Date().toISOString()} ${message}`);
const server = createServer(createHandler({ config, sources, webRoot, log }));
server.listen(config.port, process.env.HOST, () => {
  log(`Serving ${sources.length} calendar(s) on http://localhost:${config.port} from ${webRoot}`);
});

if (process.env.EXIT_WITH_STDIN) {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}
