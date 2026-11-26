/**
 * Where a calendar's iCalendar data comes from.
 */

import type { Window } from '../ical.js';

export interface CalendarSource {
  /** The id the card uses, `calendar.<name>`. */
  readonly id: string;
  readonly name: string;
  /**
   * iCalendar documents holding at least every event that overlaps the window. A source may
   * return more, such as a whole ICS feed; expansion trims to the window.
   */
  documents(window: Window): Promise<string[]>;
}

/**
 * Keeps one fetch result per key for a while, and shares a fetch already under way.
 */
export class TimedCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    const value = load();
    this.entries.set(key, { at: now, value });
    // A failed fetch is not kept, so the next request tries again.
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    this.prune(now);
    return value;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs) this.entries.delete(key);
    }
  }
}
