import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readConfigFile, writeConfigFile } from './config-file.js';

const original = `# Top comment
port: 8080 # the port

locale:
  time_zone: Australia/Perth # IANA zone
calendars:
  # The sample feed
  - id: calendar.sample
    type: ics
    url: http://example.com/a.ics
card:
  title: Calendar
  view: month
`;

test('changes only what changed, keeping comments, and keeps a backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'config-file-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, original);
  const config = readConfigFile(path)!;
  (config.locale as Record<string, unknown>).time_zone = 'Australia/Sydney';
  (config.card as Record<string, unknown>).title = 'Family';
  delete (config.card as Record<string, unknown>).view;
  writeConfigFile(path, config);
  const written = readFileSync(path, 'utf8');
  assert.match(written, /# Top comment/);
  assert.match(written, /port: 8080 # the port/);
  assert.match(written, /time_zone: Australia\/Sydney # IANA zone/);
  assert.match(written, /# The sample feed/);
  assert.match(written, /title: Family/);
  assert.doesNotMatch(written, /view:/);
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), original);
  assert.deepEqual(readConfigFile(path), config);
});

test('writes a new file when there is none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'config-file-'));
  const path = join(dir, 'config.yaml');
  assert.equal(readConfigFile(path), null);
  const config = { calendars: [{ id: 'calendar.a', type: 'ics', url: 'https://x/a.ics' }] };
  writeConfigFile(path, config);
  assert.deepEqual(readConfigFile(path), config);
});
