/**
 * A calendar read from an ICS feed URL. Read-only.
 */

import type { IcsCalendarConfig } from '../config.js';
import { TimedCache, type CalendarSource } from './source.js';

const FETCH_TIMEOUT_MS = 20_000;

export class IcsSource implements CalendarSource {
  readonly id: string;
  readonly name: string;
  private readonly url: string;
  private readonly cache: TimedCache<string>;

  constructor(config: IcsCalendarConfig, refreshMinutes: number) {
    this.id = config.id;
    this.name = config.name;
    this.url = config.url.replace(/^webcals?:\/\//i, 'https://');
    this.cache = new TimedCache(refreshMinutes * 60_000);
  }

  async documents(): Promise<string[]> {
    // The whole feed is one document whatever the window, so it is cached once.
    return [await this.cache.get('feed', () => this.fetchFeed())];
  }

  private async fetchFeed(): Promise<string> {
    const response = await fetch(this.url, {
      headers: { accept: 'text/calendar, */*;q=0.5' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${this.id}: feed answered ${response.status} ${response.statusText}`);
    }
    return response.text();
  }
}
