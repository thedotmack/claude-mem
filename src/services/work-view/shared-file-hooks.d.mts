export type SharedFileWrite = (() => void) & { value?: unknown };
export function registerSharedFileWriter(directory: string, beforeWrite: (name: string, value: unknown) => SharedFileWrite | null): () => void;
export function beforeSharedFileWrite(path: string, value: unknown): SharedFileWrite | null;
