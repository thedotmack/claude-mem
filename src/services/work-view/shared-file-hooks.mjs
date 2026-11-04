import { resolve, relative } from 'node:path';

const writers = new Map();

/** Worker/CLI owners register one DB-first writer for their own ledger only. */
export function registerSharedFileWriter(directory, beforeWrite) {
  const root = resolve(directory);
  if (writers.has(root)) throw new Error('Shared My Work writer already registered');
  writers.set(root, beforeWrite);
  return () => { if (writers.get(root) === beforeWrite) writers.delete(root); };
}

export function beforeSharedFileWrite(path, value) {
  // The completion may carry a redacted replacement value. The central file
  // writer uses it after the durable commit instead of persisting raw input.
  for (const [root, writer] of writers) {
    const name = relative(root, resolve(path));
    if (name && !name.startsWith('..') && !name.startsWith('/')) return writer(name, value);
  }
  return null;
}
