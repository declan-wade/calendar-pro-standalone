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
 * - `SETTINGS_ACCESS`: who may use the settings page: `local` (default, this computer only),
 *   `any`, or `off`
 *
 * With no configuration file, or one the server cannot use, it still starts and serves the
 * settings page, so the configuration can be written there.
 */

import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from './app.js';
import { existsSync } from 'node:fs';
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { settingsAccess } from './settings-api.js';
import { createSources } from './sources/create.js';
import type { CalendarSource } from './sources/source.js';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(process.env.CONFIG ?? 'config.yaml');
const webRoot = resolve(process.env.WEB_ROOT ?? join(here, '..', '..', 'web', 'dist'));

let config: AppConfig | null = null;
let startupError: string | null = null;
try {
  config = loadConfig(configPath);
} catch (error) {
  const reason = error instanceof ConfigError ? error.message : (error as Error).message;
  startupError = existsSync(configPath) ? reason : null;
  console.error(
    existsSync(configPath)
      ? `Cannot use ${configPath}: ${reason}. Serving the settings page to fix it.`
      : `No configuration at ${configPath} yet. Serving the settings page to write one.`,
  );
}
const port = Number(process.env.PORT ?? config?.port ?? 8080);
if (config) config.port = port;

const sources: CalendarSource[] = config ? createSources(config) : [];

const log = (message: string): void => console.log(`${new Date().toISOString()} ${message}`);
const server = createServer(
  createHandler({
    config,
    sources,
    webRoot,
    log,
    settings: {
      configPath,
      access: settingsAccess(process.env.SETTINGS_ACCESS),
      startupError,
      listeningPort: () => port,
    },
  }),
);
server.listen(port, process.env.HOST, () => {
  log(`Serving ${sources.length} calendar(s) on http://localhost:${port} from ${webRoot}`);
});

if (process.env.EXIT_WITH_STDIN) {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}
