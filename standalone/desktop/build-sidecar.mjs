/**
 * Builds the Node backend as a single executable for the desktop app to run as a Tauri sidecar.
 *
 * Steps: bundle server/src/server.ts and its dependencies into one CommonJS file, turn that into
 * a Node single executable application (SEA) blob, copy the running `node` binary to
 * src-tauri/binaries/calendar-server-<target triple>, and inject the blob into the copy. On
 * macOS the copy is re-signed ad hoc, since injecting breaks the signature Node shipped with.
 *
 * The executable is the `node` that runs this script, so build with the Node you want shipped.
 * Use an official build (nodejs.org, nvm, fnm, Volta): Homebrew's `node` links against other
 * Homebrew libraries and only runs on machines that have them.
 */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const work = join(here, '.build');
const binaries = join(root, 'src-tauri', 'binaries');

const triple = hostTriple();
const exe = process.platform === 'win32' ? '.exe' : '';
const output = join(binaries, `calendar-server-${triple}${exe}`);

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(binaries, { recursive: true });

// SEA runs CommonJS. server.ts reads `import.meta.url` for its default web root, which the
// desktop app overrides with WEB_ROOT; this keeps the expression valid in the bundle.
const bundle = join(work, 'server.cjs');
await build({
  entryPoints: [join(root, 'server', 'src', 'server.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  define: { 'import.meta.url': '__import_meta_url' },
  banner: { js: "const __import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'info',
});

const blob = join(work, 'sea-prep.blob');
const seaConfig = join(work, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2),
);
run(process.execPath, ['--experimental-sea-config', seaConfig]);

rmSync(output, { force: true });
copyFileSync(process.execPath, output);
chmodSync(output, 0o755);
if (process.platform === 'darwin') run('codesign', ['--remove-signature', output]);

const postject = [
  join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
  output,
  'NODE_SEA_BLOB',
  blob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
if (process.platform === 'darwin') postject.push('--macho-segment-name', 'NODE_SEA');
run(process.execPath, postject);

if (process.platform === 'darwin') {
  run('codesign', ['--sign', '-', output]);
  warnIfHomebrew(output);
}

console.log(`Built ${output}`);

/** The Rust host target triple, which Tauri expects as the sidecar's file name suffix. */
function hostTriple() {
  const info = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const match = /^host: (\S+)$/m.exec(info);
  if (!match) throw new Error('Could not read the host triple from `rustc -vV`');
  return match[1];
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function warnIfHomebrew(binary) {
  const libraries = execFileSync('otool', ['-L', binary], { encoding: 'utf8' });
  if (/\/(opt\/homebrew|usr\/local\/(opt|Cellar))\//.test(libraries)) {
    console.warn(
      'Warning: this node links against Homebrew libraries, so the app will only run on a Mac ' +
        'that has them installed. Build with an official Node for an app you can copy elsewhere.',
    );
  }
}
