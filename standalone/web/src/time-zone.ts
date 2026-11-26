/**
 * Makes the page keep time in a chosen IANA time zone instead of the computer's.
 *
 * The card reads and writes dates through `Date`'s local-time methods and formats them with
 * `Intl` and `toLocale*String`, all of which follow the zone of the computer the browser runs
 * on. Home Assistant behaves the same way, so the card has no option of its own for a zone. To
 * honour `locale.time_zone` without changing the card, this replaces the local-time half of
 * `Date` (the constructor and `Date.parse` for local times, the `get*`/`set*` methods without
 * `UTC`, `getTimezoneOffset`, `toString`, `toDateString`, `toTimeString`) and gives `Intl`'s date
 * formatting and `toLocale*String` the zone as their default. UTC methods, `Date.now`, `Date.UTC`
 * and times with an explicit offset are untouched, so instants never change; only how they read
 * as wall-clock time does.
 *
 * Install it before the card's code runs. It is installed only when the configuration names a
 * zone other than the computer's.
 */

const NativeDate = Date;
const NativeFormat = Intl.DateTimeFormat;
const proto = NativeDate.prototype;
const utc = {
  getFullYear: proto.getUTCFullYear,
  getMonth: proto.getUTCMonth,
  getDate: proto.getUTCDate,
  getDay: proto.getUTCDay,
  getHours: proto.getUTCHours,
  getMinutes: proto.getUTCMinutes,
  getSeconds: proto.getUTCSeconds,
  getMilliseconds: proto.getUTCMilliseconds,
};
/** The browser's own local-time getters, kept before they are replaced. */
const browserLocal = {
  getFullYear: proto.getFullYear,
  getMonth: proto.getMonth,
  getDate: proto.getDate,
  getHours: proto.getHours,
  getMinutes: proto.getMinutes,
  getSeconds: proto.getSeconds,
  getMilliseconds: proto.getMilliseconds,
};
const nativeGetTime = proto.getTime;
const nativeSetTime = proto.setTime;
const nativeParse = NativeDate.parse;
const nativeToLocaleString = proto.toLocaleString;
const nativeToLocaleDateString = proto.toLocaleDateString;
const nativeToLocaleTimeString = proto.toLocaleTimeString;

/** Offsets change at most every 15 minutes of UTC, so one reading serves each quarter hour. */
const QUARTER_HOUR = 15 * 60_000;
const MAX_CACHED = 20_000;

/** ISO forms ECMAScript reads as UTC (date only), or that carry their own offset. */
const ABSOLUTE =
  /^\s*[+-]?\d{4,6}(-\d{2}(-\d{2})?)?\s*$|(Z|[+-]\d{2}:?\d{2}|GMT|UTC)\s*(\(.*\))?\s*$/i;

let installed: string | null = null;

/**
 * Replaces the page's local time zone.
 *
 * @param zone - IANA zone, such as `Australia/Perth`
 * @returns False when the browser does not know the zone, and nothing was changed
 */
export function installTimeZone(zone: string): boolean {
  if (installed) return installed === zone;
  let parts: Intl.DateTimeFormat;
  try {
    parts = new NativeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    return false;
  }
  installed = zone;

  const offsets = new Map<number, number>();
  /** The zone's offset from UTC at an instant, in milliseconds. */
  const offsetAt = (time: number): number => {
    const bucket = Math.floor(time / QUARTER_HOUR);
    let offset = offsets.get(bucket);
    if (offset === undefined) {
      const at = bucket * QUARTER_HOUR;
      const field: Record<string, number> = {};
      for (const part of parts.formatToParts(at)) field[part.type] = Number(part.value);
      const wall = NativeDate.UTC(
        field.year,
        field.month - 1,
        field.day,
        field.hour,
        field.minute,
        field.second,
      );
      offset = wall - at;
      if (offsets.size > MAX_CACHED) offsets.clear();
      offsets.set(bucket, offset);
    }
    return offset;
  };

  /** A UTC `Date` whose UTC fields read as the zone's wall clock at `time`. */
  const wallOf = (time: number): Date => new NativeDate(time + offsetAt(time));

  /**
   * The instant the zone's wall clock reads `wall` (wall-clock fields written as UTC). A time a
   * clock change skips moves forward past the gap; a time it repeats is its first occurrence,
   * as browsers resolve local times.
   */
  const instantOfWall = (wall: number): number => {
    if (!Number.isFinite(wall)) return NaN;
    // The offsets a day either side: no zone changes its clock twice within two days.
    const before = wall - offsetAt(wall - 86_400_000);
    const after = wall - offsetAt(wall + 86_400_000);
    const reads = (time: number) => time + offsetAt(time) === wall;
    if (reads(before) && reads(after)) return Math.min(before, after);
    if (reads(before)) return before;
    if (reads(after)) return after;
    // In a gap: read with the offset from before the change, which lands past the gap.
    return before;
  };

  /** Reads a string the way the browser would, but local times as wall-clock time in `zone`. */
  const parse = (text: string): number => {
    const native = nativeParse(text);
    if (Number.isNaN(native) || ABSOLUTE.test(text)) return native;
    // A local time: read its wall clock as though it were UTC, then read that wall clock in
    // `zone`. Read through the browser's own local time instead, a time its zone skips would
    // already have moved.
    const trimmed = text.trim();
    const asUtc = /^[+-]?\d{4,6}-\d{2}-\d{2}T[\d:.,]+$/.test(trimmed)
      ? nativeParse(`${trimmed}Z`)
      : nativeParse(`${trimmed} GMT`);
    if (!Number.isNaN(asUtc)) return instantOfWall(asUtc);
    // Some other form: the browser's reading of it, as a last resort.
    const local = new NativeDate(native);
    const read = (getter: () => number) => getter.call(local);
    return instantOfWall(
      NativeDate.UTC(
        read(browserLocal.getFullYear),
        read(browserLocal.getMonth),
        read(browserLocal.getDate),
        read(browserLocal.getHours),
        read(browserLocal.getMinutes),
        read(browserLocal.getSeconds),
        read(browserLocal.getMilliseconds),
      ),
    );
  };

  // The constructor: local-time forms are read in `zone`, everything else as the browser does.
  function ZonedDate(this: unknown, ...args: unknown[]): Date | string {
    if (!new.target) return new (ZonedDate as unknown as DateConstructor)().toString();
    let time: number;
    if (args.length === 0) time = NativeDate.now();
    else if (args.length === 1) {
      const value = args[0];
      if (value instanceof NativeDate) time = nativeGetTime.call(value);
      else if (typeof value === 'string') time = parse(value);
      else time = new NativeDate(value as number).getTime();
    } else {
      const [year, month, day = 1, hour = 0, minute = 0, second = 0, ms = 0] = args.map(Number);
      const fullYear = year >= 0 && year <= 99 ? 1900 + year : year;
      const wall = new NativeDate(0);
      wall.setUTCFullYear(fullYear, month, day);
      wall.setUTCHours(hour, minute, second, ms);
      time = instantOfWall(nativeGetTime.call(wall));
    }
    return Reflect.construct(NativeDate, [time], new.target) as Date;
  }
  Object.setPrototypeOf(ZonedDate, NativeDate);
  ZonedDate.prototype = proto;
  Object.defineProperty(ZonedDate, 'name', { value: 'Date' });
  (ZonedDate as unknown as { parse: (text: string) => number }).parse = (text: string) =>
    parse(String(text));
  (ZonedDate as unknown as { now: () => number }).now = NativeDate.now;
  (ZonedDate as unknown as { UTC: typeof Date.UTC }).UTC = NativeDate.UTC;
  Object.defineProperty(proto, 'constructor', {
    value: ZonedDate,
    writable: true,
    configurable: true,
  });

  // Local getters read the zone's wall clock.
  const getter = (read: (this: Date) => number) =>
    function (this: Date): number {
      const time = nativeGetTime.call(this);
      return Number.isNaN(time) ? NaN : read.call(wallOf(time));
    };
  const define = (name: string, value: unknown): void => {
    Object.defineProperty(proto, name, { value, writable: true, configurable: true });
  };
  define('getFullYear', getter(utc.getFullYear));
  define('getMonth', getter(utc.getMonth));
  define('getDate', getter(utc.getDate));
  define('getDay', getter(utc.getDay));
  define('getHours', getter(utc.getHours));
  define('getMinutes', getter(utc.getMinutes));
  define('getSeconds', getter(utc.getSeconds));
  define('getMilliseconds', getter(utc.getMilliseconds));
  define('getYear', function (this: Date): number {
    return this.getFullYear() - 1900;
  });
  define('getTimezoneOffset', function (this: Date): number {
    const time = nativeGetTime.call(this);
    return Number.isNaN(time) ? NaN : -offsetAt(time) / 60_000;
  });

  // Local setters change the wall clock's fields and read the result back in the zone.
  const setter = (name: string) =>
    function (this: Date, ...values: number[]): number {
      const time = nativeGetTime.call(this);
      // As the native setters, only setFullYear revives an invalid date (from 1 January 1970).
      if (Number.isNaN(time) && name !== 'setUTCFullYear') return NaN;
      const wall = Number.isNaN(time) ? new NativeDate(0) : wallOf(time);
      (wall[name as keyof Date] as (...args: number[]) => number).apply(wall, values);
      return nativeSetTime.call(this, instantOfWall(nativeGetTime.call(wall)));
    };
  define('setFullYear', setter('setUTCFullYear'));
  define('setMonth', setter('setUTCMonth'));
  define('setDate', setter('setUTCDate'));
  define('setHours', setter('setUTCHours'));
  define('setMinutes', setter('setUTCMinutes'));
  define('setSeconds', setter('setUTCSeconds'));
  define('setMilliseconds', setter('setUTCMilliseconds'));

  // Formatting defaults to the zone.
  const withZone = (options: unknown): Intl.DateTimeFormatOptions => {
    const given = (options ?? {}) as Intl.DateTimeFormatOptions;
    return given.timeZone === undefined ? { ...given, timeZone: zone } : given;
  };
  function ZonedFormat(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    return new NativeFormat(locales, withZone(options));
  }
  ZonedFormat.prototype = NativeFormat.prototype;
  ZonedFormat.supportedLocalesOf = NativeFormat.supportedLocalesOf;
  Object.defineProperty(Intl, 'DateTimeFormat', {
    value: ZonedFormat,
    writable: true,
    configurable: true,
  });
  define('toLocaleString', function (this: Date, locales?: string | string[], options?: object) {
    return nativeToLocaleString.call(this, locales, withZone(options));
  });
  define(
    'toLocaleDateString',
    function (this: Date, locales?: string | string[], options?: object) {
      return nativeToLocaleDateString.call(this, locales, withZone(options));
    },
  );
  define(
    'toLocaleTimeString',
    function (this: Date, locales?: string | string[], options?: object) {
      return nativeToLocaleTimeString.call(this, locales, withZone(options));
    },
  );

  // The text forms, as browsers write them: `Thu Nov 26 2026 09:30:00 GMT+0800 (…)`.
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const zoneName = new NativeFormat('en-US', { timeZone: zone, timeZoneName: 'long' });
  const dateText = (date: Date) =>
    `${days[date.getDay()]} ${months[date.getMonth()]} ${pad(date.getDate())} ${pad(date.getFullYear(), 4)}`;
  const timeText = (date: Date) => {
    const offset = -date.getTimezoneOffset();
    const sign = offset < 0 ? '-' : '+';
    const abs = Math.abs(offset);
    const name =
      zoneName.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? zone;
    return (
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
      `GMT${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)} (${name})`
    );
  };
  const valid = (date: Date) => !Number.isNaN(nativeGetTime.call(date));
  define('toString', function (this: Date): string {
    return valid(this) ? `${dateText(this)} ${timeText(this)}` : 'Invalid Date';
  });
  define('toDateString', function (this: Date): string {
    return valid(this) ? dateText(this) : 'Invalid Date';
  });
  define('toTimeString', function (this: Date): string {
    return valid(this) ? timeText(this) : 'Invalid Date';
  });

  Object.defineProperty(globalThis, 'Date', {
    value: ZonedDate,
    writable: true,
    configurable: true,
  });
  return true;
}
