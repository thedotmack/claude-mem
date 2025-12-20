/**
 * Type declarations for bun:sqlite built-in module
 * Bun provides SQLite as a built-in module at runtime
 */
declare module 'bun:sqlite' {
  export interface RunResult {
    changes: number;
    lastInsertRowid: number;
  }

  export interface Statement<T = any> {
    run(...params: any[]): RunResult;
    get(...params: any[]): T | null;
    all(...params: any[]): T[];
    finalize(): void;
  }

  export class Database {
    constructor(filename: string, options?: { readonly?: boolean; create?: boolean; readwrite?: boolean });

    query<T = any>(sql: string): Statement<T>;
    prepare<T = any>(sql: string): Statement<T>;
    run(sql: string, ...params: any[]): RunResult;
    exec(sql: string): void;
    close(): void;
    transaction<T>(fn: () => T): () => T;

    readonly filename: string;
    readonly inTransaction: boolean;
  }
}
