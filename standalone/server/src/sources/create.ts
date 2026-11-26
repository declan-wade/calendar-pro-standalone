/**
 * Builds the calendar sources a configuration lists.
 */

import type { AppConfig } from '../config.js';
import { CaldavSource } from './caldav.js';
import { IcsSource } from './ics.js';
import type { CalendarSource } from './source.js';

/**
 * One source per configured calendar, in the configuration's order.
 *
 * @param config - The checked configuration
 * @returns The sources
 */
export function createSources(config: AppConfig): CalendarSource[] {
  return config.calendars.map((calendar) =>
    calendar.type === 'ics'
      ? new IcsSource(calendar, config.refresh_minutes)
      : new CaldavSource(calendar, config.refresh_minutes),
  );
}
