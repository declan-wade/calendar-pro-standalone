/**
 * Builds the web app into web/dist: the shim bundle, the static files, and a copy of the
 * card bundle from the repository root's dist/ (run `npm run build:card` first).
 */

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
const cardBundle = join(here, '..', '..', 'dist', 'calendar-card-pro.js');

if (!existsSync(cardBundle)) {
  console.error(`Missing ${cardBundle}. Run "npm run build:card" first.`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'card'), { recursive: true });

await build({
  entryPoints: { app: join(here, 'src', 'main.ts') },
  outdir: out,
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  chunkNames: 'chunks/[name]-[hash]',
  logLevel: 'info',
});

cpSync(join(here, 'public'), out, { recursive: true });
cpSync(cardBundle, join(out, 'card', 'calendar-card-pro.js'));
console.log(`Built ${out}`);
