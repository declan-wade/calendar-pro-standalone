import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkConfig, checkNotifications } from './config.js';
import type { HaEvent } from './ical.js';
import { GRACE_MS, Notifier, readWindow, remindersFor, type Notice } from './notifications.js';
import type { CalendarSource } from './sources/source.js';

const PERTH = 'Australia/Perth';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:meeting
DTSTART:20261127T013000Z
DTEND:20261127T020000Z
SUMMARY:Planning
LOCATION:Room 2
END:VEVENT
BEGIN:VEVENT
UID:holiday
DTSTART;VALUE=DATE:20261127
DTEND;VALUE=DATE:20261128
SUMMARY:Day off
END:VEVENT
END:VCALENDAR`;

const source = (id: string): CalendarSource => ({
  id,
  name: 'Work',
  documents: async () => [ICS],
});

function configWith(notifications: Record<string, unknown>, notify = true) {
  return checkConfig({
    calendars: [{ id: 'calendar.work', type: 'ics', url: 'https://x/a.ics', notify }],
    locale: { time_zone: PERTH, time_format: '24' },
    notifications,
  });
}

test('notifications default to off, 10 minutes before, nothing for all-day events', () => {
  assert.deepEqual(checkNotifications(undefined), {
    enabled: false,
    minutes_before: 10,
    all_day_at: null,
  });
  assert.throws(() => checkNotifications({ minutes_before: -1 }), /minutes_before/);
  assert.throws(() => checkNotifications({ minutes_before: 2000 }), /minutes_before/);
  assert.throws(() => checkNotifications({ all_day_at: '9am' }), /all_day_at/);
  assert.throws(() => checkNotifications({ enabled: 'yes' }), /enabled/);
});

test('a calendar notifies unless it says notify: false', () => {
  assert.equal(configWith({}).calendars[0].notify, true);
  assert.equal(configWith({}, false).calendars[0].notify, false);
});

test('works out when each event is due, in the configured zone', () => {
  const events: HaEvent[] = [
    {
      start: { dateTime: '2026-11-27T09:30:00+08:00' },
      end: { dateTime: '2026-11-27T10:00:00+08:00' },
      summary: 'Planning',
      description: null,
      location: 'Room 2',
      uid: 'meeting',
      recurrence_id: null,
      rrule: null,
    },
    {
      start: { date: '2026-11-27' },
      end: { date: '2026-11-28' },
      summary: 'Day off',
      description: null,
      location: null,
      uid: 'holiday',
      recurrence_id: null,
      rrule: null,
    },
  ];
  const reminders = remindersFor(
    'calendar.work',
    events,
    { enabled: true, minutes_before: 15, all_day_at: '08:00' },
    { timeZone: PERTH, language: 'en', timeFormat: '24', calendarName: 'Work' },
    new Date('2026-11-27T00:00:00Z'),
  );
  assert.equal(reminders.length, 2);
  // 9:15 and 8:00 in Perth, UTC+8.
  assert.equal(reminders[0].at.toISOString(), '2026-11-27T01:15:00.000Z');
  assert.equal(reminders[0].title, 'Planning');
  assert.equal(reminders[0].body, '09:30 – 10:00\nRoom 2\nWork');
  assert.equal(reminders[1].at.toISOString(), '2026-11-27T00:00:00.000Z');
  assert.equal(reminders[1].body, 'All day\nWork');

  const noAllDay = remindersFor(
    'calendar.work',
    events,
    { enabled: true, minutes_before: 15, all_day_at: null },
    { timeZone: PERTH, language: 'en', timeFormat: '24', calendarName: 'Work' },
    new Date('2026-11-27T00:00:00Z'),
  );
  assert.equal(noAllDay.length, 1);
});

test('names the weekday of an event on another day', () => {
  const [reminder] = remindersFor(
    'calendar.work',
    [
      {
        start: { dateTime: '2026-11-28T09:00:00+08:00' },
        end: { dateTime: '2026-11-28T09:00:00+08:00' },
        summary: '',
        description: null,
        location: null,
        uid: 'x',
        recurrence_id: null,
        rrule: null,
      },
    ],
    { enabled: true, minutes_before: 1440, all_day_at: null },
    { timeZone: PERTH, language: 'en', timeFormat: '24', calendarName: 'Work' },
    new Date('2026-11-27T01:00:00Z'),
  );
  assert.equal(reminder.title, '(No title)');
  assert.equal(reminder.body, 'Sat 09:00\nWork');
});

test('the read window only moves once a day', () => {
  const morning = readWindow(new Date('2026-11-27T01:00:00Z'));
  const evening = readWindow(new Date('2026-11-27T23:00:00Z'));
  assert.deepEqual(morning, evening);
  assert.equal(morning.start.toISOString(), '2026-11-26T00:00:00.000Z');
  assert.equal(morning.end.toISOString(), '2026-11-30T00:00:00.000Z');
});

test('emits each notification once when due, and drops ones too late to show', async () => {
  let now = new Date('2026-11-27T01:10:00Z');
  const shown: Notice[] = [];
  const notifier = new Notifier({ emit: (notice) => shown.push(notice), now: () => now });
  notifier.update(configWith({ enabled: true, minutes_before: 10 }), [source('calendar.work')]);

  await notifier.tick();
  assert.equal(shown.length, 0, 'not due until 01:20');

  now = new Date('2026-11-27T01:20:00Z');
  await notifier.tick();
  assert.deepEqual(shown, [{ title: 'Planning', body: '09:30 – 10:00\nRoom 2\nWork' }]);

  now = new Date('2026-11-27T01:20:30Z');
  await notifier.tick();
  assert.equal(shown.length, 1, 'shown once');

  // A notifier started after the grace period has passed shows nothing.
  const late: Notice[] = [];
  const after = new Notifier({
    emit: (notice) => late.push(notice),
    now: () => new Date(Date.parse('2026-11-27T01:20:00Z') + GRACE_MS + 1000),
  });
  after.update(configWith({ enabled: true, minutes_before: 10 }), [source('calendar.work')]);
  await after.tick();
  assert.equal(late.length, 0);
});

test('shows nothing when notifications are off or the calendar opts out', async () => {
  const now = () => new Date('2026-11-27T01:20:00Z');
  const shown: Notice[] = [];
  const off = new Notifier({ emit: (notice) => shown.push(notice), now });
  off.update(configWith({ enabled: false }), [source('calendar.work')]);
  await off.tick();
  const optedOut = new Notifier({ emit: (notice) => shown.push(notice), now });
  optedOut.update(configWith({ enabled: true }, false), [source('calendar.work')]);
  await optedOut.tick();
  assert.equal(shown.length, 0);
});

test('a failing calendar is logged and the others still notify', async () => {
  const shown: Notice[] = [];
  const logged: string[] = [];
  const notifier = new Notifier({
    emit: (notice) => shown.push(notice),
    log: (message) => logged.push(message),
    now: () => new Date('2026-11-27T01:20:00Z'),
  });
  const config = checkConfig({
    calendars: [
      { id: 'calendar.broken', type: 'ics', url: 'https://x/b.ics' },
      { id: 'calendar.work', type: 'ics', url: 'https://x/a.ics' },
    ],
    locale: { time_zone: PERTH, time_format: '24' },
    notifications: { enabled: true },
  });
  const broken: CalendarSource = {
    id: 'calendar.broken',
    name: 'Broken',
    documents: async () => {
      throw new Error('offline');
    },
  };
  notifier.update(config, [broken, source('calendar.work')]);
  await notifier.tick();
  assert.equal(shown.length, 1);
  assert.match(logged[0], /calendar\.broken: offline/);
});
