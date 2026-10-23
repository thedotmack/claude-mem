export const LEDGER_DIR: string;
export const GOALS_STALE_MS: number;
export const AGENT_WRITTEN_PROMPTS_FILE: string;
export interface RefreshNeeds { due: number; ungrouped: number; goalsStale: boolean; unaligned: number; needed: boolean }
export interface LedgerDatabase { prepare(sql: string): { all(...params: unknown[]): any[]; get(...params: unknown[]): any } }
export function refreshNeeds(options: { dir?: string; database: LedgerDatabase; now?: number; days?: number }): RefreshNeeds;
export function writeJsonAtomic(path: string, value: unknown): void;
export function readLedger(dir?: string): Record<string, any>;
export function readCandidates(database: LedgerDatabase, options: { sinceEpoch?: number; conversationKeys?: string[] | null; fullAsks?: boolean; excludedPromptIds?: Set<number> | null }): any[];
export function ledgerSignature(dir?: string): string;
export function runCli(argv: string[], options?: { dir?: string; database?: LedgerDatabase | null; now?: number; print?: (value: any) => void }): void;
