import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expandCalendar, type HaEvent } from './ical.js';
import { instantOf, isoInZone } from './time.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(join(here, '..', '..', 'examples', 'sample.ics'), 'utf8');
const PERTH = 'Australia/Perth';

// Monday 23 to Monday 30 November 2026, Perth midnights.
const week = {
  start: new Date('2026-11-22T16:00:00Z'),
  end: new Date('2026-11-29T16:00:00Z'),
};

const starts = (events: HaEvent[]): string[] =>
  events.map((e) => ('dateTime' in e.start ? e.start.dateTime : e.start.date) + ' ' + e.summary);

test('expands a weekly rule, skipping EXDATE and cancelled events', () => {
  assert.deepEqual(starts(expandCalendar([sample], week, PERTH)), [
    '2026-11-23T09:00:00+08:00 Standup',
    '2026-11-25T09:00:00+08:00 Standup',
    '2026-11-26T12:30:00+08:00 Lunch with Sam',
    '2026-11-27T14:00:00+08:00 Dentist',
    '2026-11-28 Weekend away',
  ]);
});

test('applies an override to its occurrence and keeps its recurrence_id', () => {
  const window = { start: new Date('2026-11-29T16:00:00Z'), end: new Date('2026-11-30T16:00:00Z') };
  const [moved] = expandCalendar([sample], window, PERTH);
  assert.equal(moved.summary, 'Standup (moved)');
  assert.deepEqual(moved.start, { dateTime: '2026-11-30T10:00:00+08:00' });
  assert.equal(moved.recurrence_id, '20261130T090000');
  assert.equal(moved.uid, 'standup@example.com');
});

test('reports all-day events with an exclusive end date', () => {
  const allDay = expandCalendar([sample], week, PERTH).find((e) => e.summary === 'Weekend away');
  assert.deepEqual(allDay?.start, { date: '2026-11-28' });
  assert.deepEqual(allDay?.end, { date: '2026-11-30' });
});

test('keeps an all-day event that started before the window', () => {
  const window = { start: new Date('2026-11-28T16:00:00Z'), end: new Date('2026-11-29T16:00:00Z') };
  assert.deepEqual(starts(expandCalendar([sample], window, PERTH)), ['2026-11-28 Weekend away']);
});

test('reads a zone defined only by VTIMEZONE', () => {
  const dentist = expandCalendar([sample], week, PERTH).find((e) => e.summary === 'Dentist');
  assert.deepEqual(dentist?.start, { dateTime: '2026-11-27T14:00:00+08:00' });
});

test('writes times in the configured zone', () => {
  const sydney = expandCalendar([sample], week, 'Australia/Sydney');
  const lunch = sydney.find((e) => e.summary === 'Lunch with Sam');
  assert.deepEqual(lunch?.start, { dateTime: '2026-11-26T15:30:00+11:00' });
});

test('skips a document it cannot parse and keeps the rest', () => {
  const events = expandCalendar(['not a calendar', sample], week, PERTH);
  assert.equal(events.length, 5);
});

test('reads floating times in the configured zone', () => {
  const floating = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:floating',
    'DTSTART:20261124T080000',
    'DTEND:20261124T090000',
    'SUMMARY:Floating',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const [event] = expandCalendar([floating], week, 'Europe/Berlin');
  assert.deepEqual(event.start, { dateTime: '2026-11-24T08:00:00+01:00' });
});

test('converts wall-clock times across a daylight saving change', () => {
  // Sydney moves to +11:00 at 02:00 on 4 October 2026.
  const before = instantOf(
    { year: 2026, month: 10, day: 3, hour: 9, minute: 0, second: 0 },
    'Australia/Sydney',
  );
  const after = instantOf(
    { year: 2026, month: 10, day: 5, hour: 9, minute: 0, second: 0 },
    'Australia/Sydney',
  );
  assert.equal(isoInZone(before, 'Australia/Sydney'), '2026-10-03T09:00:00+10:00');
  assert.equal(isoInZone(after, 'Australia/Sydney'), '2026-10-05T09:00:00+11:00');
});

test('reads a TZID with no VTIMEZONE in its own zone, not the configured one', () => {
  // The sample's Standup is 09:00 Australia/Perth, a zone the file names without defining it.
  const events = expandCalendar([sample], week, 'Australia/Sydney');
  const standup = events.find((event) => event.summary === 'Standup')!;
  assert.deepEqual(standup.start, { dateTime: '2026-11-23T12:00:00+11:00' });
  const dentist = events.find((event) => event.summary === 'Dentist')!;
  assert.deepEqual(dentist.start, { dateTime: '2026-11-27T17:00:00+11:00' });
});
