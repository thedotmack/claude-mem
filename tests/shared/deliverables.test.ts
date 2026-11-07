import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import {
  copyDeliverableIntoBucket,
  deliverableBucketFileName,
  deliverableBucketFolderName,
  isInsideDeliverablesDir,
  resolveDeliverableBucketDir,
  sha256OfFile,
} from '../../src/shared/deliverables.js';

let dir: string;
let deliverablesDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-mem-deliverables-'));
  deliverablesDir = join(dir, 'deliverables');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('deliverableBucketFolderName', () => {
  it('keeps a plain key and makes separators and unsafe characters into dashes', () => {
    expect(deliverableBucketFolderName('claude-mem')).toBe('claude-mem');
    expect(deliverableBucketFolderName('thedotmack/claude-mem')).toBe('thedotmack-claude-mem');
    expect(deliverableBucketFolderName('claude-mem/new-feature-7f692d82')).toBe('claude-mem-new-feature-7f692d82');
    expect(deliverableBucketFolderName('CMEM Cloud ☁️/branched-mayonnaise')).toBe('CMEM Cloud ☁️-branched-mayonnaise');
    expect(deliverableBucketFolderName('C:\\work\\repo')).toBe('C-work-repo');
    expect(deliverableBucketFolderName('..')).toBe('unknown-project');
    expect(deliverableBucketFolderName('')).toBe('unknown-project');
  });

  it('cuts a key over NAME_MAX to 255 bytes and keeps a hash of the whole key', () => {
    const long = 'é'.repeat(200);
    const name = deliverableBucketFolderName(long);
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(255);
    expect(name).toMatch(/-[a-f0-9]{8}$/);
    expect(deliverableBucketFolderName(`${long}x`)).not.toBe(name);
    // Cut at a code point, never inside one: an emoji key keeps whole emoji.
    const emoji = deliverableBucketFolderName('🎉'.repeat(100));
    expect(Buffer.byteLength(emoji, 'utf8')).toBeLessThanOrEqual(255);
    expect(emoji).not.toMatch(/\ufffd/);
    expect(emoji).toMatch(/^(?:🎉)+-[a-f0-9]{8}$/u);
  });
});

describe('deliverableBucketFileName', () => {
  const sha = 'a'.repeat(64);

  it('keeps the whole name within NAME_MAX: the stem gives way, the hash and extension stay', () => {
    expect(deliverableBucketFileName('/w/Launch report: final?.html', sha)).toBe('Launch report- final-aaaaaaaa.html');
    const long = deliverableBucketFileName(`/w/${'r'.repeat(250)}.html`, sha);
    expect(Buffer.byteLength(long, 'utf8')).toBe(255);
    expect(long).toMatch(/^r+-aaaaaaaa\.html$/);
    const wide = deliverableBucketFileName(`/w/${'é'.repeat(250)}.pdf`, sha);
    expect(Buffer.byteLength(wide, 'utf8')).toBeLessThanOrEqual(255);
    expect(wide).toMatch(/^é+-aaaaaaaa\.pdf$/);
    expect(deliverableBucketFileName('/w/.hidden', sha)).toBe('hidden-aaaaaaaa');
  });

  it('refuses an extension that leaves no room for a name', () => {
    expect(() => deliverableBucketFileName(`/w/x.${'e'.repeat(260)}`, sha)).toThrow(/leaves no room/);
  });
});

describe('copyDeliverableIntoBucket', () => {
  it('names the copy by its content, reuses it for the same bytes, and keeps a revised file beside it', () => {
    const source = join(dir, 'report.md');
    writeFileSync(source, '# Launch report\n');
    const sha = sha256OfFile(source);

    const first = copyDeliverableIntoBucket(source, 'owner/repo', deliverablesDir);
    expect(first.bucketPath).toBe(join(resolveDeliverableBucketDir('owner/repo', deliverablesDir), deliverableBucketFileName(source, sha)));
    expect(first.bucketPath).toBe(join(deliverablesDir, 'owner-repo', `report-${sha.slice(0, 8)}.md`));
    expect(first).toMatchObject({ sha256: sha, bytes: 16, reused: false });
    expect(readFileSync(first.bucketPath, 'utf8')).toBe('# Launch report\n');

    expect(copyDeliverableIntoBucket(source, 'owner/repo', deliverablesDir)).toEqual({ ...first, reused: true });

    writeFileSync(source, '# Launch report, revised\n');
    const revised = copyDeliverableIntoBucket(source, 'owner/repo', deliverablesDir);
    expect(revised.reused).toBe(false);
    expect(revised.bucketPath).not.toBe(first.bucketPath);
    expect(existsSync(first.bucketPath)).toBe(true);
    expect(readFileSync(revised.bucketPath, 'utf8')).toBe('# Launch report, revised\n');
  });

  it('copies a file whose name is at NAME_MAX, and names and records the bytes it copied', () => {
    const source = join(dir, `${'n'.repeat(250)}.html`);
    writeFileSync(source, '<h1>Long name</h1>');
    const copy = copyDeliverableIntoBucket(source, 'p', deliverablesDir);
    expect(existsSync(copy.bucketPath)).toBe(true);
    expect(Buffer.byteLength(basename(copy.bucketPath), 'utf8')).toBeLessThanOrEqual(255);
    // The recorded hash and the hash in the name are of the copy itself, never of a source read a second time.
    expect(sha256OfFile(copy.bucketPath)).toBe(copy.sha256);
    expect(basename(copy.bucketPath)).toContain(`-${copy.sha256.slice(0, 8)}.html`);
    expect(copy.bytes).toBe(18);
    // Nothing temporary is left in the bucket, whether the copy was kept or already there.
    copyDeliverableIntoBucket(source, 'p', deliverablesDir);
    expect(readdirSync(join(deliverablesDir, 'p')).filter(name => name.startsWith('.partial-'))).toEqual([]);
    expect(readdirSync(join(deliverablesDir, 'p'))).toHaveLength(1);
  });

  it('refuses anything but a regular file and leaves no partial copy behind', () => {
    const folder = join(dir, 'deck.key');
    mkdirSync(folder);
    expect(() => copyDeliverableIntoBucket(folder, 'p', deliverablesDir)).toThrow(/not a regular file/);
    expect(() => copyDeliverableIntoBucket(join(dir, 'missing.pdf'), 'p', deliverablesDir)).toThrow();
    expect(existsSync(join(deliverablesDir, 'p'))).toBe(false);
  });

  it('serves only paths inside the deliverables directory', () => {
    expect(isInsideDeliverablesDir(join(deliverablesDir, 'p', 'a.pdf'), deliverablesDir)).toBe(true);
    expect(isInsideDeliverablesDir(deliverablesDir, deliverablesDir)).toBe(false);
    expect(isInsideDeliverablesDir(join(dir, 'a.pdf'), deliverablesDir)).toBe(false);
    expect(isInsideDeliverablesDir(join(deliverablesDir, '..', 'a.pdf'), deliverablesDir)).toBe(false);
  });
});
