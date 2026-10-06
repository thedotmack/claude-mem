import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface OwnedFile { name: string; contents: Buffer; }

export function readProjectAttribution(packageRoot: string): OwnedFile[] {
  // Read both inputs before a caller creates or changes its destination.
  return ['LICENSE', 'NOTICE'].map(name => ({ name, contents: readFileSync(join(packageRoot, name)) }));
}

function statIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Replace only an explicit owned set; retain the old files until every rename succeeds. */
export function replaceOwnedFiles(destination: string, files: OwnedFile[]): void {
  const names = new Set<string>();
  const destinationStat = statIfPresent(destination);
  if (destinationStat && !destinationStat.isDirectory()) throw new Error('Installation directory is not a real directory: ' + destination);
  for (const file of files) {
    if (!file.name || basename(file.name) !== file.name || file.name === '.' || file.name === '..' || names.has(file.name)) {
      throw new Error('Invalid or repeated owned filename: ' + file.name);
    }
    names.add(file.name);
    const current = statIfPresent(join(destination, file.name));
    if (current && !current.isFile()) throw new Error('Owned destination is not a regular file: ' + join(destination, file.name));
  }

  mkdirSync(dirname(destination), { recursive: true });
  const stage = mkdtempSync(join(dirname(destination), '.claude-mem-files-'));
  const backup = join(stage, 'previous');
  const applied: { name: string; backedUp: boolean; installed: boolean }[] = [];
  let createdDestination = false;
  let committed = false;
  let rollbackComplete = true;
  try {
    chmodSync(stage, 0o700);
    mkdirSync(backup, { mode: 0o700 });
    for (const file of files) writeFileSync(join(stage, file.name), file.contents, { flag: 'wx', mode: 0o644 });
    if (!destinationStat) {
      mkdirSync(destination);
      createdDestination = true;
    }
    for (const file of files) {
      const change = { name: file.name, backedUp: false, installed: false };
      applied.push(change);
      const target = join(destination, file.name);
      if (statIfPresent(target)) {
        renameSync(target, join(backup, file.name));
        change.backedUp = true;
      }
      renameSync(join(stage, file.name), target);
      change.installed = true;
    }
    committed = true;
  } catch (failure) {
    const rollbackErrors: unknown[] = [];
    for (const change of applied.reverse()) {
      try {
        const target = join(destination, change.name);
        if (change.installed) rmSync(target, { force: true });
        if (change.backedUp) renameSync(join(backup, change.name), target);
      } catch (error) { rollbackErrors.push(error); }
    }
    if (createdDestination) {
      try { if (readdirSync(destination).length === 0) rmdirSync(destination); }
      catch (error) { rollbackErrors.push(error); }
    }
    rollbackComplete = rollbackErrors.length === 0;
    if (!rollbackComplete) {
      throw new AggregateError([failure, ...rollbackErrors], 'Could not replace owned files: ' + String(failure) + '; recovery files remain at ' + stage, { cause: failure });
    }
    throw failure;
  } finally {
    if (committed || rollbackComplete) {
      // A cleanup refusal after commit does not turn an installed set into a reported failure.
      try { rmSync(stage, { recursive: true, force: true }); }
      catch (error) { console.warn('Could not remove installation staging directory ' + stage + ': ' + String(error)); }
    }
  }
}
