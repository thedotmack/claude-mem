import { createHash, randomBytes } from 'crypto';
import { closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync } from 'fs';
import { basename, extname, join, relative, isAbsolute } from 'path';
import { resolveDataDir } from './paths.js';

/**
 * The deliverables bucket: one folder per project under the data directory
 * (~/.claude-mem/deliverables/<project>/) holding a copy of every file an
 * agent made for a person to open — a deck, a report, a page, an image.
 *
 * The Stop hook copies them here (src/cli/deliverables-capture.ts) because the
 * place they were made (a worktree, a scratch folder, a temp directory) is
 * routinely deleted. The worker records each copy in its `deliverables` table
 * and My Work links the copy on the request's card, so asking for a deck ends
 * with the deck one click away in the viewer.
 */
export const DELIVERABLES_DIRNAME = 'deliverables';

export function resolveDeliverablesDir(): string {
  return join(resolveDataDir(), DELIVERABLES_DIRNAME);
}

/** NAME_MAX on APFS, ext4 and NTFS is 255 bytes: the bound on a bucket folder's name and on a copy's name. */
const NAME_MAX_BYTES = 255;
/** A folder name cut to fit keeps this much of a hash of the whole key, so two long keys never share a bucket. */
const KEY_HASH_LENGTH = 8;
/** Path separators and the characters no common filesystem accepts in a name. */
const UNSAFE_NAME_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;

function safeName(value: string): string {
  return value.replace(UNSAFE_NAME_CHARACTERS, '-').replace(/\s+/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '');
}

/** `value` shortened, whole code points at a time, until `${value}${suffix}` fits in NAME_MAX_BYTES; its first code point always stays. */
function fitName(value: string, suffix: string): string {
  const chars = Array.from(value);
  while (chars.length > 1 && Buffer.byteLength(`${chars.join('')}${suffix}`, 'utf8') > NAME_MAX_BYTES) chars.pop();
  return chars.join('').replace(/[\s.-]+$/, '');
}

/** A project key (`claude-mem`, `owner/repo`, `parent/worktree`) as the bucket folder's name. */
export function deliverableBucketFolderName(projectKey: string): string {
  const cleaned = safeName(projectKey);
  if (!cleaned) return 'unknown-project';
  if (Buffer.byteLength(cleaned, 'utf8') <= NAME_MAX_BYTES) return cleaned;
  const hash = createHash('sha256').update(projectKey).digest('hex').slice(0, KEY_HASH_LENGTH);
  return `${fitName(cleaned, `-${hash}`)}-${hash}`;
}

export function resolveDeliverableBucketDir(projectKey: string, deliverablesDir: string = resolveDeliverablesDir()): string {
  return join(deliverablesDir, deliverableBucketFolderName(projectKey));
}

/** True when `path` is inside the deliverables directory: the only place the deliverables route may serve from. */
export function isInsideDeliverablesDir(path: string, deliverablesDir: string = resolveDeliverablesDir()): boolean {
  const rel = relative(deliverablesDir, path);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * The copy runs inside the Stop hook, whose host timeout is 120 s
 * (plugin/hooks/hooks.json). A 512 MiB file copies and hashes in a few
 * seconds on a local disk; a larger one risks the timeout, so it is reported
 * (copyDeliverableIntoBucket throws, the hook logs it) and never copied silently.
 */
export const DELIVERABLE_MAX_BYTES = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
/** `report.md` becomes `report-3f9a1c2b.md`: enough of the content hash to tell versions apart while the name stays readable. */
const CONTENT_HASH_LENGTH = 8;

export interface DeliverableBucketCopy {
  bucketPath: string;
  sha256: string;
  bytes: number;
  /** The bucket already held this content under this name; nothing new was kept. */
  reused: boolean;
}

export function sha256OfFile(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
    let read = 0;
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * The bucket name of a copy: the source's stem made filesystem-safe, then the
 * content hash, then the extension, the whole kept within NAME_MAX. The stem
 * gives way so a file with a long but valid name still copies; the hash and
 * the extension stay. Throws when the extension alone leaves no room for a name.
 */
export function deliverableBucketFileName(sourcePath: string, sha256: string): string {
  const ext = extname(sourcePath);
  const suffix = `-${sha256.slice(0, CONTENT_HASH_LENGTH)}${ext}`;
  const name = `${fitName(safeName(basename(sourcePath, ext)) || 'deliverable', suffix)}${suffix}`;
  if (Buffer.byteLength(name, 'utf8') > NAME_MAX_BYTES) {
    throw new Error(`${basename(sourcePath)}: its extension leaves no room for a ${NAME_MAX_BYTES}-byte bucket name`);
  }
  return name;
}

/**
 * Copies one file into the project's bucket under a name made from its
 * content, so the same bytes land once however many Stops see them and a
 * revised file lands beside its earlier version. The bytes are copied first
 * and hashed in the bucket, so the name and the recorded sha256 describe the
 * copy itself even when the source is rewritten while it is copied. Throws
 * when the source is not a regular file or is over DELIVERABLE_MAX_BYTES.
 */
export function copyDeliverableIntoBucket(sourcePath: string, projectKey: string, deliverablesDir: string = resolveDeliverablesDir()): DeliverableBucketCopy {
  const source = statSync(sourcePath);
  if (!source.isFile()) throw new Error(`${sourcePath} is not a regular file`);
  if (source.size > DELIVERABLE_MAX_BYTES) {
    throw new Error(`${sourcePath} is ${source.size} bytes, over the ${DELIVERABLE_MAX_BYTES}-byte limit for one bucket copy`);
  }
  const bucketDir = resolveDeliverableBucketDir(projectKey, deliverablesDir);
  mkdirSync(bucketDir, { recursive: true });
  // A short name of its own while the copy is made, so the final name may use the whole NAME_MAX budget;
  // the rename publishes the copy whole, so a reader never opens a half-written deliverable.
  const partial = join(bucketDir, `.partial-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    // A reflink where the filesystem has them (APFS, Btrfs, XFS): the source as it is at this instant, at no copy cost.
    copyFileSync(sourcePath, partial, constants.COPYFILE_FICLONE);
    const bytes = statSync(partial).size;
    if (bytes > DELIVERABLE_MAX_BYTES) {
      throw new Error(`${sourcePath} grew to ${bytes} bytes while it was copied, over the ${DELIVERABLE_MAX_BYTES}-byte limit for one bucket copy`);
    }
    const sha256 = sha256OfFile(partial);
    const bucketPath = join(bucketDir, deliverableBucketFileName(sourcePath, sha256));
    if (existsSync(bucketPath)) {
      unlinkSync(partial);
      return { bucketPath, sha256, bytes, reused: true };
    }
    renameSync(partial, bucketPath);
    return { bucketPath, sha256, bytes, reused: false };
  } catch (error) {
    try { unlinkSync(partial); } catch { /* never written, or already renamed or removed */ }
    throw error;
  }
}
