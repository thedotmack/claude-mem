export const LEDGER_DIR: string;
export const GOALS_STALE_MS: number;
export interface RefreshNeeds { due: number; ungrouped: number; goalsStale: boolean; unaligned: number; needed: boolean }
export interface LedgerDatabase { prepare(sql: string): { all(...params: unknown[]): any[]; get(...params: unknown[]): any } }
export function refreshNeeds(options: { dir?: string; database: LedgerDatabase; now?: number; days?: number }): RefreshNeeds;
export function writeJsonAtomic(path: string, value: unknown): void;
export function readLedger(dir?: string): Record<string, any>;
export function ledgerSignature(dir?: string): string;
export function runCli(argv: string[], options?: { dir?: string; database?: LedgerDatabase | null; now?: number; print?: (value: any) => void }): void;
