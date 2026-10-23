export const LEDGER_DIR: string;
export const GOALS_STALE_MS: number;
export interface RefreshNeeds { due: number; ungrouped: number; goalsStale: boolean; unaligned: number; needed: boolean }
export interface LedgerDatabase { prepare(sql: string): { all(...params: unknown[]): any[]; get(...params: unknown[]): any } }
export interface SavedGoal { goal: string; kind: 'priority' | 'open-ask'; rank: number | null; title: string; product: string | null; latestAt: string | null; timesAsked: number | null; evidence: Array<{ at: string; quote: string }> }
export interface SavedGoals { summary: string | null; generatedAt: string | null; mapPath: string | null; goals: SavedGoal[] }
export function readGoals(database: LedgerDatabase): SavedGoals;
export function refreshNeeds(options: { dir?: string; database: LedgerDatabase; now?: number; days?: number }): RefreshNeeds;
export function goalsAddedSince(alignment: { goals?: string[] } | null | undefined, goalKeys: string[]): string[];
export function writeJsonAtomic(path: string, value: unknown): void;
export function readLedger(dir?: string): Record<string, any>;
export function ledgerSignature(dir?: string): string;
export function runCli(argv: string[], options?: { dir?: string; database?: LedgerDatabase | null; now?: number; print?: (value: any) => void }): void;
