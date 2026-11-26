import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkConfig, ConfigError } from './config.js';

const ics = { id: 'calendar.home', type: 'ics', url: 'https://example.com/a.ics' };

test('fills defaults and shows every calendar when the card names none', () => {
  const config = checkConfig({ calendars: [ics], locale: { time_zone: 'Australia/Perth' } });
  assert.equal(config.port, 8080);
  assert.equal(config.locale.language, 'en');
  assert.deepEqual(config.card.entities, ['calendar.home']);
});

test('rejects an id that is not calendar.<name>', () => {
  assert.throws(() => checkConfig({ calendars: [{ ...ics, id: 'home' }] }), ConfigError);
});

test('rejects a duplicate id', () => {
  assert.throws(() => checkConfig({ calendars: [ics, ics] }), /listed twice/);
});

test('requires the CalDAV fields', () => {
  assert.throws(
    () => checkConfig({ calendars: [{ id: 'calendar.work', type: 'caldav' }] }),
    /server_url is required/,
  );
});

test('rejects a time zone the system does not know', () => {
  assert.throws(
    () => checkConfig({ calendars: [ics], locale: { time_zone: 'Mars/Olympus' } }),
    /not a time zone/,
  );
});

test('says whether the file names a time zone', () => {
  assert.equal(checkConfig({ calendars: [ics] }).locale.time_zone_set, false);
  const set = checkConfig({ calendars: [ics], locale: { time_zone: 'Australia/Perth' } });
  assert.equal(set.locale.time_zone_set, true);
});
