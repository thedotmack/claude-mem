import type { Database } from 'bun:sqlite';
export function syncablePromptSql(column: string, accountSql?: string): string;
export function workspaceAccountSql(db: Database, account?: string): string | undefined;
