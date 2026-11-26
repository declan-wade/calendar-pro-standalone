/**
 * Loads the card bundle, once the page keeps time in the configured zone.
 *
 * The card is loaded here rather than by a script tag so the time zone is in place before any
 * of its code runs: dates it makes while loading then read in the right zone too.
 */

import { installTimeZone } from './time-zone';

let loading: Promise<unknown> | null = null;

/**
 * Has the page keep time in `locale.time_zone` when the configuration names one other than the
 * computer's. With none named, times stay in the computer's zone, as in Home Assistant.
 *
 * @param locale - The configuration's locale
 */
export function useConfiguredTimeZone(locale: {
  time_zone: string;
  time_zone_set?: boolean;
}): void {
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!locale.time_zone_set || locale.time_zone === browser) return;
  if (!installTimeZone(locale.time_zone)) {
    console.warn(`[standalone] This browser does not know the time zone ${locale.time_zone}`);
  }
}

/**
 * Loads `card/calendar-card-pro.js` beside the page, once.
 *
 * @returns When the card's module has run
 */
export function loadCard(): Promise<unknown> {
  // A computed address, so the bundler leaves the card to load as its own file.
  const url = new URL('card/calendar-card-pro.js', document.baseURI).href;
  loading ??= import(/* @vite-ignore */ url);
  return loading;
}
