/**
 * Reads and writes config.yaml for the settings page.
 *
 * A save changes only the values that changed, in place in the parsed document, so comments
 * and the layout of everything else in the file stay as they were. The previous file is kept
 * beside it as `config.yaml.bak`, and the new one is written to a temporary file first and
 * moved into place, so a failed write never leaves half a file.
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';

type Plain = Record<string, unknown>;

/**
 * The file as written, without defaults filled in.
 *
 * @param path - Path to config.yaml
 * @returns Its contents, or null when there is no file
 */
export function readConfigFile(path: string): Plain | null {
  if (!existsSync(path)) return null;
  const value = parseDocument(readFileSync(path, 'utf8')).toJS() as unknown;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Plain) : {};
}

/**
 * Writes a new configuration, keeping the file's comments where the values they sit by remain.
 *
 * @param path - Path to config.yaml
 * @param value - The whole new configuration
 */
export function writeConfigFile(path: string, value: Plain): void {
  const exists = existsSync(path);
  const document = exists
    ? parseDocument(readFileSync(path, 'utf8'))
    : parseDocument('# Written by the Calendar Pro settings page.\n');
  if (!isMap(document.contents)) document.contents = document.createNode({}) as never;
  merge(document, [], value);
  const text = document.toString({ lineWidth: 0 });
  if (exists) copyFileSync(path, `${path}.bak`);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Sets `value` at `path` in the document, touching only the nodes that differ. */
function merge(document: Document, path: Array<string | number>, value: unknown): void {
  const node = path.length ? document.getIn(path, true) : document.contents;
  if (isPlainObject(value) && isMap(node)) {
    for (const pair of [...node.items]) {
      const key = isScalar(pair.key) ? pair.key.value : pair.key;
      if (typeof key === 'string' && !(key in value)) document.deleteIn([...path, key]);
    }
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) document.deleteIn([...path, key]);
      else merge(document, [...path, key], child);
    }
    return;
  }
  if (Array.isArray(value) && isSeq(node) && node.items.length === value.length) {
    value.forEach((child, index) => merge(document, [...path, index], child));
    return;
  }
  if (isScalar(node) && !isPlainObject(value) && !Array.isArray(value)) {
    if (node.value !== value) node.value = value;
    return;
  }
  if (path.length === 0) return;
  document.setIn(path, document.createNode(value));
}

function isPlainObject(value: unknown): value is Plain {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
