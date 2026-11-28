/** Writes the file (the shared ledger adapter renames it under its database write lock) and reports whether recording it
 * is complete or, with the decision already saved, left for its reconciler. */
export type SharedFileWrite = () => { materialization: 'complete' | 'pending'; reason?: string } | void;
/** readHash: the hash of the file the value was built from; the writer refuses the value when the file changed since. */
export type SharedFileWriteOptions = { readHash?: string };
export function registerSharedFileWriter(directory: string, beforeWrite: (name: string, value: unknown, options?: SharedFileWriteOptions) => SharedFileWrite | null): () => void;
export function beforeSharedFileWrite(path: string, value: unknown, options?: SharedFileWriteOptions): SharedFileWrite | null;
