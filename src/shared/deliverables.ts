import { createHash } from 'crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync } from 'fs';
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

/** NAME_MAX on APFS, ext4 and NTFS is 255 bytes; a folder name cut to fit keeps a hash of the key so two long keys never share a bucket. */
const FOLDER_NAME_MAX_BYTES = 255;
const KEY_HASH_LENGTH = 8;
/** Path separators and the characters no common filesystem accepts in a name. */
const UNSAFE_NAME_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;

function safeName(value: string): string {
  return value.replace(UNSAFE_NAME_CHARACTERS, '-').replace(/\s+/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '');
}

/** A project key (`claude-mem`, `owner/repo`, `parent/worktree`) as the bucket folder's name. */
export function deliverableBucketFolderName(projectKey: string): string {
  const cleaned = safeName(projectKey);
  if (!cleaned) return 'unknown-project';
  if (Buffer.byteLength(cleaned, 'utf8') <= FOLDER_NAME_MAX_BYTES) return cleaned;
  const hash = createHash('sha256').update(projectKey).digest('hex').slice(0, KEY_HASH_LENGTH);
  let cut = cleaned;
  while (Buffer.byteLength(`${cut}-${hash}`, 'utf8') > FOLDER_NAME_MAX_BYTES) cut = cut.slice(0, -1);
  return `${cut.replace(/[\s.-]+$/, '')}-${hash}`;
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
 * (plugin/hooks/hooks.json). A 512 MiB file hashes and copies in a few
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
  /** The bucket already held this content under this name; nothing was written. */
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

/** The bucket name of a copy: the source's stem made filesystem-safe, then the content hash, then the extension. */
export function deliverableBucketFileName(sourcePath: string, sha256: string): string {
  const ext = extname(sourcePath);
  const stem = safeName(basename(sourcePath, ext)) || 'deliverable';
  return `${stem}-${sha256.slice(0, CONTENT_HASH_LENGTH)}${ext}`;
}

/**
 * Copies one file into the project's bucket under a name made from its
 * content, so the same bytes land once however many Stops see them and a
 * revised file lands beside its earlier version. Throws when the source is
 * not a regular file or is over DELIVERABLE_MAX_BYTES.
 */
export function copyDeliverableIntoBucket(sourcePath: string, projectKey: string, deliverablesDir: string = resolveDeliverablesDir()): DeliverableBucketCopy {
  const stat = statSync(sourcePath);
  if (!stat.isFile()) throw new Error(`${sourcePath} is not a regular file`);
  if (stat.size > DELIVERABLE_MAX_BYTES) {
    throw new Error(`${sourcePath} is ${stat.size} bytes, over the ${DELIVERABLE_MAX_BYTES}-byte limit for one bucket copy`);
  }
  const sha256 = sha256OfFile(sourcePath);
  const bucketDir = resolveDeliverableBucketDir(projectKey, deliverablesDir);
  const bucketPath = join(bucketDir, deliverableBucketFileName(sourcePath, sha256));
  if (existsSync(bucketPath)) return { bucketPath, sha256, bytes: stat.size, reused: true };
  mkdirSync(bucketDir, { recursive: true });
  // Copy under a temporary name and rename, so a reader never opens a half-written deliverable.
  const partial = `${bucketPath}.${process.pid}.partial`;
  try {
    copyFileSync(sourcePath, partial);
    renameSync(partial, bucketPath);
  } catch (error) {
    try { unlinkSync(partial); } catch { /* nothing was written */ }
    throw error;
  }
  return { bucketPath, sha256, bytes: stat.size, reused: false };
}
