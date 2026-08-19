const {
  chmodSync,
  copyFileSync,
  lstatSync,
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

function copyFile(sourcePath, destPath, sourceStat, stats) {
  const destStat = lstatSync(destPath, { throwIfNoEntry: false });

  // rsync's default quick check: same size and same whole-second mtime is
  // treated as up to date, so repeated syncs stay cheap and idempotent.
  if (
    destStat &&
    destStat.isFile() &&
    destStat.size === sourceStat.size &&
    Math.floor(destStat.mtimeMs / 1000) === Math.floor(sourceStat.mtimeMs / 1000)
  ) {
    return;
  }

  if (destStat && !destStat.isFile()) {
    rmSync(destPath, { recursive: true, force: true });
  }

  copyFileSync(sourcePath, destPath);
  chmodSync(destPath, sourceStat.mode & 0o777);
  utimesSync(destPath, sourceStat.atime, sourceStat.mtime);
  stats.copied++;
}

function copySymlink(sourcePath, destPath, stats) {
  const target = readlinkSync(sourcePath);
  const destStat = lstatSync(destPath, { throwIfNoEntry: false });

  if (destStat && destStat.isSymbolicLink() && readlinkSync(destPath) === target) {
    return;
  }

  if (destStat) {
    rmSync(destPath, { recursive: true, force: true });
  }

  symlinkSync(target, destPath);
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
      copySymlink(sourcePath, destPath, stats);
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

  return stats;
}

function mirrorDirectory(sourceDir, destDir, options = {}) {
  const rules = compileExcludes(options.exclude || []);
  return mirrorInto(sourceDir, destDir, '', rules, { copied: 0, deleted: 0 });
}

module.exports = { mirrorDirectory, compileExcludes, isExcluded };
