import path from 'node:path';

const writers = new Map();

/** Worker/CLI owners register one DB-first writer for their own ledger only. */
export function registerSharedFileWriter(directory, beforeWrite) {
  const root = path.resolve(directory);
  if (writers.has(root)) throw new Error('Shared My Work writer already registered');
  writers.set(root, beforeWrite);
  return () => { if (writers.get(root) === beforeWrite) writers.delete(root); };
}

/**
 * The file's name inside the ledger, always with forward slashes because that
 * is how the adapter recognizes `progress/` files. Null when it is outside.
 */
export function ledgerRelativeName(root, filePath, paths = path) {
  const name = paths.relative(root, paths.resolve(filePath));
  if (!name || name === '..' || name.startsWith(`..${paths.sep}`) || paths.isAbsolute(name)) return null;
  return name.split(paths.sep).join('/');
}

export function beforeSharedFileWrite(filePath, value) {
  // The completion may carry a redacted replacement value. The central file
  // writer uses it after the durable commit instead of persisting raw input.
  for (const [root, writer] of writers) {
    const name = ledgerRelativeName(root, filePath);
    if (name) return writer(name, value);
  }
  return null;
}
