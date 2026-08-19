const {
  chmodSync,
  copyFileSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
} = require('fs');
const path = require('path');

// Stand-in for `rsync -a --delete --exclude=...`, which is unavailable on
// Windows. Supported pattern syntax is the rsync subset this repo actually
// uses: `*` (no `/`), `**` (any), `?`, a leading `/` to anchor at the mirror
// root, and a trailing `/` to match directories only. Unanchored patterns match
// at any depth, on directory boundaries, exactly as rsync matches them.
//
// `-a` is `-rlptgoD`. Reconciled here: recursion (-r), symlinks as symlinks
// (-l), permissions (-p, including setuid/setgid/sticky), and modification
// times (-t) on files, directories and symlinks alike. Not reconciled: owner
// and group (-o/-g, which rsync itself can only apply as root) and device or
// special files (-D, likewise root-only and absent from a source checkout).
// `-a` does not imply -H/-A/-X, so hardlinks, ACLs and xattrs are out of scope
// for both tools.
const PERMISSION_MASK = 0o7777;

function globToRegExpSource(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index++;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return source;
}

function compileExcludes(patterns) {
  return patterns
    .filter(Boolean)
    .map(pattern => {
      let body = pattern;
      const dirOnly = body.endsWith('/');
      if (dirOnly) body = body.slice(0, -1);
      const anchored = body.startsWith('/');
      if (anchored) body = body.slice(1);
      const source = globToRegExpSource(body);
      return { dirOnly, matcher: new RegExp(anchored ? `^${source}$` : `(^|/)${source}$`) };
    });
}

function isExcluded(rules, relativePath, isDirectory) {
  return rules.some(rule => (!rule.dirOnly || isDirectory) && rule.matcher.test(relativePath));
}

function joinRelative(base, name) {
  return base ? `${base}/${name}` : name;
}

// rsync compares whole seconds by default.
function sameModifiedTime(destStat, sourceStat) {
  return Math.floor(destStat.mtimeMs / 1000) === Math.floor(sourceStat.mtimeMs / 1000);
}

function samePermissions(destStat, sourceStat) {
  return (destStat.mode & PERMISSION_MASK) === (sourceStat.mode & PERMISSION_MASK);
}

// Metadata is reconciled even when the content copy is skipped: the quick check
// exists to avoid rewriting bytes, not to leave a destination that disagrees
// with the source about permissions. A source that revokes the executable bit
// without touching size or mtime must not leave an executable behind.
function syncMetadata(destPath, destStat, sourceStat, stats) {
  const isLink = destStat.isSymbolicLink();
  let changed = false;

  if (!isLink && !samePermissions(destStat, sourceStat)) {
    chmodSync(destPath, sourceStat.mode & PERMISSION_MASK);
    changed = true;
  }

  if (!sameModifiedTime(destStat, sourceStat)) {
    if (isLink) {
      lutimesSync(destPath, sourceStat.atime, sourceStat.mtime);
    } else {
      utimesSync(destPath, sourceStat.atime, sourceStat.mtime);
    }
    changed = true;
  }

  if (changed) stats.metadata++;
  return changed;
}

function copyFile(sourcePath, destPath, sourceStat, stats) {
  const destStat = lstatSync(destPath, { throwIfNoEntry: false });

  if (
    destStat &&
    destStat.isFile() &&
    destStat.size === sourceStat.size &&
    sameModifiedTime(destStat, sourceStat)
  ) {
    syncMetadata(destPath, destStat, sourceStat, stats);
    return;
  }

  if (destStat && !destStat.isFile()) {
    rmSync(destPath, { recursive: true, force: true });
  }

  copyFileSync(sourcePath, destPath);
  chmodSync(destPath, sourceStat.mode & PERMISSION_MASK);
  utimesSync(destPath, sourceStat.atime, sourceStat.mtime);
  stats.copied++;
}

function copySymlink(sourcePath, destPath, sourceStat, stats) {
  const target = readlinkSync(sourcePath);
  const destStat = lstatSync(destPath, { throwIfNoEntry: false });

  if (destStat && destStat.isSymbolicLink() && readlinkSync(destPath) === target) {
    syncMetadata(destPath, destStat, sourceStat, stats);
    return;
  }

  if (destStat) {
    rmSync(destPath, { recursive: true, force: true });
  }

  symlinkSync(target, destPath);
  lutimesSync(destPath, sourceStat.atime, sourceStat.mtime);
  stats.copied++;
}

function mirrorInto(sourceDir, destDir, relativeBase, rules, stats) {
  mkdirSync(destDir, { recursive: true });

  const sourceEntries = readdirSync(sourceDir, { withFileTypes: true }).filter(
    entry => !isExcluded(rules, joinRelative(relativeBase, entry.name), entry.isDirectory())
  );
  const sourceNames = new Set(sourceEntries.map(entry => entry.name));

  // `--delete`, including its receiver-side protection: excluded paths (.git,
  // node_modules, plugin/data, ...) are left alone rather than wiped.
  for (const entry of readdirSync(destDir, { withFileTypes: true })) {
    if (sourceNames.has(entry.name)) continue;
    if (isExcluded(rules, joinRelative(relativeBase, entry.name), entry.isDirectory())) continue;
    rmSync(path.join(destDir, entry.name), { recursive: true, force: true });
    stats.deleted++;
  }

  for (const entry of sourceEntries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isSymbolicLink()) {
      copySymlink(sourcePath, destPath, lstatSync(sourcePath), stats);
      continue;
    }

    if (entry.isDirectory()) {
      const destStat = lstatSync(destPath, { throwIfNoEntry: false });
      if (destStat && !destStat.isDirectory()) {
        rmSync(destPath, { recursive: true, force: true });
      }
      mirrorInto(sourcePath, destPath, joinRelative(relativeBase, entry.name), rules, stats);
      continue;
    }

    copyFile(sourcePath, destPath, lstatSync(sourcePath), stats);
  }

  // Directories are reconciled last: writing their children bumps the
  // destination mtime, and tightening permissions before the writes would lock
  // the mirror out of its own target.
  syncMetadata(destDir, lstatSync(destDir), lstatSync(sourceDir), stats);

  return stats;
}

function mirrorDirectory(sourceDir, destDir, options = {}) {
  const rules = compileExcludes(options.exclude || []);
  return mirrorInto(sourceDir, destDir, '', rules, { copied: 0, metadata: 0, deleted: 0 });
}

module.exports = { mirrorDirectory, compileExcludes, isExcluded };
