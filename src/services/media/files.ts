import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { MediaError } from '../../shared/media-contract.js';

export function assertContained(root: string, target: string): void {
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new MediaError('unsupported_source');
}

export function assertNoSymlinks(root: string, target: string): void {
  assertContained(root, target);
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new MediaError('unsupported_source');
  let current = root;
  for (const component of relative(root, target).split(sep)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) throw new MediaError('unsupported_source');
  }
  if (realpathSync(target) !== resolve(target)) throw new MediaError('unsupported_source');
}

/** Bounded fd read, no-follow where supported, and identity checks around IO.
 * https://nodejs.org/api/fs.html#fsopensyncpath-flags-mode
 * https://nodejs.org/api/fs.html#file-system-flags
 */
export function readContainedFile(root: string, target: string, maxBytes: number): Buffer {
  root = realpathSync(root);
  target = resolve(target);
  assertNoSymlinks(root, target);
  const before = lstatSync(target);
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) throw new MediaError('unsupported_source');
    if (!stat.size || stat.size > maxBytes) throw new MediaError('source_too_large');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const length = readSync(fd, bytes, offset, bytes.length-offset, offset);
      if (!length) throw new MediaError('invalid_image');
      offset += length;
    }
    const after = fstatSync(fd);
    assertNoSymlinks(root, target);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || lstatSync(target).ino !== stat.ino) throw new MediaError('unsupported_source');
    return bytes;
  } finally { closeSync(fd); }
}
