// One icon per focus area: the owner's own file, on this computer only. It is a file under the work-view folder and
// never a work-state row, because my-focus rows sync between devices and a row would name a file the other device
// does not have.
//   focus-icons/<sha256(focusAreaId)>.<first 12 hex of the content's sha256>.<webp|png|svg>
// The version is in the name, so listing the folder once gives every area's version without opening a file.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FOCUS_ICON_CONTENT_TYPES, FOCUS_ICON_UPLOAD_FORMATS, MAX_FOCUS_ICON_SVG_BYTES, MAX_FOCUS_ICON_UPLOAD_BYTES } from './focus-icon-limits.mjs';

export const FOCUS_ICONS_DIR = 'focus-icons';
export * from './focus-icon-limits.mjs';

const ICON_FILE = /^([0-9a-f]{64})\.([0-9a-f]{12})\.(webp|png|svg)$/;

export const focusIconKey = (focusAreaId) => createHash('sha256').update(String(focusAreaId)).digest('hex');

/** 'png' or 'webp' when the bytes start as that format does; null for anything else, whatever the page called it. */
export function sniffFocusIconUpload(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Every icon in the folder, by focusIconKey: one directory listing. A write that was cut off between its rename and
 * its cleanup leaves two files for one area; the newer one is the icon. */
export function readFocusIconIndex(ledgerDir) {
  const index = new Map();
  if (!ledgerDir) return index;
  let names = [];
  try { names = readdirSync(join(ledgerDir, FOCUS_ICONS_DIR)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const modified = (name) => { try { return statSync(join(ledgerDir, FOCUS_ICONS_DIR, name)).mtimeMs; } catch { return 0; } };
  for (const name of names.sort()) {
    const match = ICON_FILE.exec(name);
    if (!match) continue;
    const [, key, version, format] = match;
    const known = index.get(key);
    if (known && modified(known.file) >= modified(name)) continue;
    index.set(key, { file: name, version, format });
  }
  return index;
}

/** The icon of one area: its version, format and path, or null. */
export function readFocusIcon(ledgerDir, focusAreaId) {
  const icon = readFocusIconIndex(ledgerDir).get(focusIconKey(focusAreaId));
  return icon ? { ...icon, path: join(ledgerDir, FOCUS_ICONS_DIR, icon.file) } : null;
}

function removeOthers(ledgerDir, key, keep) {
  let names = [];
  try { names = readdirSync(join(ledgerDir, FOCUS_ICONS_DIR)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let removed = false;
  for (const name of names) {
    if (name === keep || ICON_FILE.exec(name)?.[1] !== key) continue;
    rmSync(join(ledgerDir, FOCUS_ICONS_DIR, name), { force: true });
    removed = true;
  }
  return removed;
}

/** Saves the area's icon, replacing any it had: written beside its name, renamed into place, then the old one removed. Answers the version. */
export function writeFocusIcon(ledgerDir, focusAreaId, format, bytes) {
  if (!Object.hasOwn(FOCUS_ICON_CONTENT_TYPES, format)) throw new TypeError(`Unknown focus icon format: ${format}`);
  const dir = join(ledgerDir, FOCUS_ICONS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = focusIconKey(focusAreaId);
  const version = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const name = `${key}.${version}.${format}`;
  const temporary = join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, join(dir, name));
  removeOthers(ledgerDir, key, name);
  return version;
}

/** Deletes the area's icon. True when there was one. */
export const removeFocusIcon = (ledgerDir, focusAreaId) => removeOthers(ledgerDir, focusIconKey(focusAreaId), null);
