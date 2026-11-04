import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export const MAX_SKILL_BYTES = 1024 * 1024;

export class SkillCatalogError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/** A root's descendants, using path segments (also on Windows). */
export function containsPath(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameFile(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs && a.size === b.size;
}

/** Follow an approved canonical binding only. Like memory/file-watcher, bind the descriptor
 * to the inspected inode and recheck the directory path after reading. */
export async function readSkillFile(file: string, root: string) {
  const verifyPath = async () => {
    if (path.basename(file) !== 'SKILL.md' || !containsPath(root, file) ||
        await realpath(root) !== root || await realpath(file) !== file) {
      throw new SkillCatalogError(403, 'This skill moved outside its discovered location.');
    }
  };
  await verifyPath();
  const prior = await lstat(file, { bigint: true });
  if (!prior.isFile() || prior.nlink !== 1n) throw new SkillCatalogError(403, 'Choose a regular skill file with a single link.');
  if (prior.size > BigInt(MAX_SKILL_BYTES)) throw new SkillCatalogError(413, 'This skill exceeds the local editor size limit.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(opened, prior)) throw new SkillCatalogError(409, 'This skill changed while opening. Refresh and try again.');
    const data = Buffer.alloc(Number(opened.size) + 1);
    let count = 0;
    while (count < data.length) {
      const { bytesRead } = await handle.read(data, count, data.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    await verifyPath();
    if (BigInt(count) !== opened.size || !sameFile(opened, await lstat(file, { bigint: true })) ||
        !sameFile(opened, await handle.stat({ bigint: true }))) {
      throw new SkillCatalogError(409, 'This skill changed while reading. Refresh and try again.');
    }
    const bytes = data.subarray(0, count);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new SkillCatalogError(422, 'This skill contains invalid UTF-8.'); }
    const mode = Number(opened.mode) & 0o777;
    let editable = (mode & 0o222) !== 0;
    if (editable) {
      try { await Promise.all([access(file, constants.W_OK), access(path.dirname(file), constants.W_OK)]); }
      catch { editable = false; }
    }
    return { text, revision: sha256(bytes), mode, editable };
  } finally {
    await handle.close();
  }
}
