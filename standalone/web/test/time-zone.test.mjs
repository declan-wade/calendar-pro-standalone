/**
 * Checks web/src/time-zone.ts against the real thing: a page whose computer is in one zone,
 * with the zone set to another, must read and make dates exactly as a computer in that other
 * zone does. Each side runs in a Node process with its own `TZ`, and their answers are compared.
 */

import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'time-zone-'));
await build({
  entryPoints: [join(here, '..', 'src', 'time-zone.ts')],
  outfile: join(dir, 'time-zone.mjs'),
  bundle: true,
  format: 'esm',
  logLevel: 'error',
});

// Reads and makes dates every way the card does, around every clock change of 2026.
writeFileSync(
  join(dir, 'probe.mjs'),
  `
const [mode, zone] = process.argv.slice(2);
if (mode === 'shim') (await import('./time-zone.mjs')).installTimeZone(zone);
const out = [];
const base = Date.UTC(2026, 0, 1);
for (let i = 0; i < 365 * 4; i++) {
  const d = new Date(base + i * 6 * 3600_000 + 17 * 60_000);
  out.push([d.getFullYear(), d.getMonth(), d.getDate(), d.getDay(), d.getHours(), d.getMinutes(), d.getTimezoneOffset()].join());
}
for (let m = 0; m < 12; m++) for (let day = 1; day <= 28; day += 1) for (const h of [0, 1, 2, 2.5, 3, 12, 23]) {
  const hour = Math.floor(h), minute = (h % 1) * 60;
  out.push(new Date(2026, m, day, hour, minute).getTime());
  const text = \`2026-\${String(m + 1).padStart(2, '0')}-\${String(day).padStart(2, '0')}T\${String(hour).padStart(2, '0')}:\${minute ? '30' : '00'}:00\`;
  out.push(Date.parse(text), new Date(text).getTime());
  const d = new Date(2026, m, day, 12); d.setHours(hour, minute); out.push(d.getTime());
  const e = new Date(2026, m, day); e.setDate(e.getDate() + 1); out.push(e.getTime(), e.getDay());
}
out.push(Date.parse('2026-04-05'), new Date('2026-04-05T10:00:00Z').getTime());
out.push(new Intl.DateTimeFormat('en-AU', { dateStyle: 'full', timeStyle: 'long' }).format(new Date(base)));
out.push(new Date(base).toLocaleString('en-AU'), new Date(base).toString().replace(/ \\(.*\\)$/, ''));
out.push(Intl.DateTimeFormat().resolvedOptions().timeZone, new Date(base) instanceof Date);
console.log(JSON.stringify(out));
`,
);

const run = (tz, ...args) =>
  JSON.parse(
    execFileSync(process.execPath, [join(dir, 'probe.mjs'), ...args], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    }),
  );

for (const zone of [
  'Australia/Sydney',
  'Australia/Lord_Howe',
  'America/New_York',
  'Europe/London',
]) {
  test(`reads and makes dates as a computer in ${zone} does`, () => {
    const expected = run(zone, 'native');
    for (const computer of ['Asia/Tokyo', 'America/Los_Angeles']) {
      assert.deepEqual(run(computer, 'shim', zone), expected, `on a computer in ${computer}`);
    }
  });
}
