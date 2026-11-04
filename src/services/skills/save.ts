import { randomUUID } from 'node:crypto';
import { constants, lstatSync, realpathSync, renameSync, type BigIntStats } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { renameWithWindowsRetry } from '../../shared/atomic-json.js';
import { SkillCatalog, skillMetadata, type SkillEntry } from './catalog.js';
import { MAX_SKILL_BYTES, sha256, SkillCatalogError } from './files.js';

type SavedSkill = { entry: SkillEntry; revision: string };
const writes = new Map<string, Promise<unknown>>();
const changed = () => new SkillCatalogError(409, 'This skill changed on disk. Your draft is ready to compare or reapply.');

export function validateSkillText(text: string): void {
  if (typeof text !== 'string' || /[\uD800-\uDFFF\u0000]/u.test(text)) {
    throw new SkillCatalogError(422, 'The document must contain valid UTF-8 Markdown.');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES) throw new SkillCatalogError(413, 'This skill exceeds the local editor size limit.');
}

function sameInode(first: BigIntStats, second: BigIntStats) {
  return first.dev === second.dev && first.ino === second.ino;
}

function sameSnapshot(first: BigIntStats, second: BigIntStats) {
  return sameInode(first, second) && first.size === second.size && first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs && first.mode === second.mode && second.nlink === 1n;
}

/** Source and temp share one directory. Revalidate before *each* Windows rename retry. On Linux,
 * anchor pathname operations to the open directory so a parent symlink swap cannot redirect the write. */
async function writeRevision(catalog: SkillCatalog, id: string, expectedRevision: string, text: string): Promise<SavedSkill> {
  const initial = await catalog.read(id);
  if (!initial.editable) throw new SkillCatalogError(403, 'This skill is read-only.');
  const revision = sha256(text);
  if (revision === initial.revision) return { entry: initial.entry, revision };
  if (initial.revision !== expectedRevision) throw changed();
  const metadata = skillMetadata(text, path.basename(path.dirname(initial.path)), initial.entry.agent);
  if (metadata.problem) throw new SkillCatalogError(422, metadata.problem);
  const directory = path.dirname(initial.path);
  const targetBefore = await lstat(initial.path, { bigint: true });
  const directoryBefore = await lstat(directory, { bigint: true });
  if (!directoryBefore.isDirectory() || !targetBefore.isFile() || targetBefore.nlink !== 1n) throw changed();
  // Windows does not support opening directories this way. Its final pathname checks still apply.
  const directoryHandle = process.platform === 'win32' ? undefined :
    await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
  const anchored = process.platform === 'linux' && directoryHandle ? '/proc/self/fd/' + directoryHandle.fd : directory;
  const target = path.join(anchored, 'SKILL.md');
  const tmp = path.join(anchored, '.SKILL.' + randomUUID() + '.tmp');
  let tempIdentity: BigIntStats | undefined;
  let renamed = false;
  const verifyDirectory = () => {
    if (realpathSync(directory) !== directory || !sameInode(directoryBefore, lstatSync(directory, { bigint: true }))) throw changed();
  };
  try {
    if (directoryHandle && !sameInode(directoryBefore, await directoryHandle.stat({ bigint: true }))) throw changed();
    verifyDirectory();
    const handle = await open(tmp, 'wx', 0o600);
    try {
      tempIdentity = await handle.stat({ bigint: true });
      await handle.writeFile(text, 'utf8');
      await handle.chmod(initial.mode);
      await handle.sync();
      tempIdentity = await handle.stat({ bigint: true });
    } finally { await handle.close(); }
    const current = await catalog.read(id);
    if (!current.editable || current.root !== initial.root || current.path !== initial.path ||
        current.revision !== expectedRevision || current.mode !== initial.mode) throw changed();

    renameWithWindowsRetry(tmp, target, (from, to) => {
      verifyDirectory();
      if (realpathSync(initial.path) !== initial.path || !sameSnapshot(targetBefore, lstatSync(to, { bigint: true })) ||
          !sameSnapshot(tempIdentity!, lstatSync(from, { bigint: true }))) throw changed();
      renameSync(from, to);
    });
    renamed = true;
    // Some filesystems allow atomic replacement but do not support directory fsync.
    try { await directoryHandle?.sync(); } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    return { entry: { ...current.entry, ...metadata }, revision };
  } finally {
    try {
      if (!renamed && tempIdentity) {
        // Never remove a replacement at the temp name or follow a moved parent while cleaning up.
        if (anchored === directory) verifyDirectory();
        const existing = await lstat(tmp, { bigint: true }).catch(() => null);
        if (existing && sameInode(tempIdentity, existing)) await unlink(tmp);
      }
    } finally { await directoryHandle?.close(); }
  }
}

/** Saves from the viewer and sync materializer share the same per-canonical-file critical section. */
export async function saveSkill(catalog: SkillCatalog, id: string, expectedRevision: string, text: string): Promise<SavedSkill> {
  validateSkillText(text);
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) throw new SkillCatalogError(400, 'A valid base revision is required.');
  const pending = (writes.get(id) ?? Promise.resolve()).catch(() => {}).then(() => writeRevision(catalog, id, expectedRevision, text));
  writes.set(id, pending);
  try { return await pending; }
  catch (error) {
    if (error instanceof SkillCatalogError) throw error;
    switch ((error as NodeJS.ErrnoException).code) {
      case 'ENOENT': case 'ENOTDIR': case 'ELOOP': throw changed();
      case 'EACCES': case 'EPERM': case 'EROFS': throw new SkillCatalogError(403, 'This skill folder is read-only.');
      default: throw new SkillCatalogError(500, 'Could not save the skill file.');
    }
  } finally { if (writes.get(id) === pending) writes.delete(id); }
}
