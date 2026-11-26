/**
 * CalDAV passwords, by the name of the environment variable each one stands in for.
 *
 * The configuration never holds a password, only `password_env`, the variable's name. A password
 * typed on the settings page is kept here, in memory, and wins over the environment, so a new
 * calendar works without a restart. Keeping it across restarts is the runtime's job: the desktop
 * app saves it to the OS credential store and passes it back in the environment next time; a
 * server run from a terminal or Docker reads it from its environment.
 */

const typed = new Map<string, string>();

/**
 * The password for a variable name: one typed on the settings page, else the environment's.
 *
 * @param name - The `password_env` name
 * @returns The password, or undefined when there is none
 */
export function passwordFor(name: string): string | undefined {
  const value = typed.get(name) ?? process.env[name];
  return value === '' ? undefined : value;
}

/**
 * Keeps a password typed on the settings page until the backend stops.
 *
 * @param name - The `password_env` name
 * @param password - The password
 */
export function setPassword(name: string, password: string): void {
  typed.set(name, password);
}

/**
 * Where a password comes from, for the settings page. The password itself is never sent.
 *
 * @param name - The `password_env` name
 * @returns `typed` (this session), `environment`, or `missing`
 */
export function passwordSource(name: string): 'typed' | 'environment' | 'missing' {
  if (typed.has(name)) return 'typed';
  if (process.env[name]) return 'environment';
  return 'missing';
}
