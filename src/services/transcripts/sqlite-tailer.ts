import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import type { SqliteQueryConfig, RegistryResolver } from './types.js';

export interface SqliteTargetRef {
  dbPath: string;
  /** Optional display name / source annotation (e.g. registry project path). */
  label?: string;
}

export function resolveRegistry(registry: RegistryResolver): SqliteTargetRef[] {
  switch (registry) {
    case 'crush-projects':
      return resolveCrushProjects();
    default:
      return [];
  }
}

function resolveCrushProjects(): SqliteTargetRef[] {
  const projectsPath = join(homedir(), '.local', 'share', 'crush', 'projects.json');
  if (!existsSync(projectsPath)) return [];

  try {
    const raw = readFileSync(projectsPath, 'utf-8');
    const parsed = JSON.parse(raw) as { projects?: Array<{ path?: string; data_dir?: string }> };
    const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];

    const refs: SqliteTargetRef[] = [];
    for (const p of projects) {
      const dataDir = typeof p?.data_dir === 'string' ? p.data_dir : undefined;
      if (!dataDir) continue;
      const dbPath = join(dataDir, 'crush.db');
      if (!existsSync(dbPath)) continue;
      refs.push({ dbPath, label: typeof p?.path === 'string' ? p.path : dataDir });
    }
    return refs;
  } catch (error) {
    logger.warn(
      'TRANSCRIPT',
      'Failed to resolve crush-projects registry',
      { projectsPath },
      error instanceof Error ? error : undefined,
    );
    return [];
  }
}

type Timer = ReturnType<typeof setInterval>;

export class SqliteTailer {
  private db: Database | null = null;
  private timer: Timer | null = null;
  private running = false;
  private pollMs: number;
  private cursor: number;

  constructor(
    private readonly dbPath: string,
    private readonly query: SqliteQueryConfig,
    initialCursor: number,
    private readonly onEntry: (entry: Record<string, unknown>) => Promise<void>,
    private readonly onCursor: (cursor: number) => void,
  ) {
    this.cursor = Number.isFinite(initialCursor) ? initialCursor : 0;
    this.pollMs = query.pollIntervalMs ?? 2000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    try {
      this.db = new Database(this.dbPath, { readonly: true, create: false });
    } catch (error) {
      logger.warn(
        'TRANSCRIPT',
        'Failed to open SQLite tailer target',
        { dbPath: this.dbPath },
        error instanceof Error ? error : undefined,
      );
      this.running = false;
      return;
    }
    this.poll().catch(() => undefined);
    this.timer = setInterval(() => {
      this.poll().catch(() => undefined);
    }, this.pollMs);
  }

  close(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.db?.close();
    } catch {
      // ignore
    }
    this.db = null;
  }

  poke(): void {
    this.poll().catch(() => undefined);
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.db) return;

    let rows: Array<Record<string, unknown>>;
    try {
      rows = this.db
        .query(this.query.sql)
        .all({ $cursor: this.cursor }) as Array<Record<string, unknown>>;
    } catch (error) {
      logger.debug(
        'TRANSCRIPT',
        'SQLite poll failed; will retry',
        { dbPath: this.dbPath },
        error instanceof Error ? error : undefined,
      );
      return;
    }

    if (!rows || rows.length === 0) return;

    for (const row of rows) {
      const parsed = this.parseRow(row);
      try {
        await this.onEntry(parsed);
      } catch (error) {
        logger.debug(
          'TRANSCRIPT',
          'onEntry handler failed for sqlite row',
          { dbPath: this.dbPath },
          error instanceof Error ? error : undefined,
        );
      }

      const raw = row[this.query.cursorColumn];
      const cursorNum = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(cursorNum) && cursorNum > this.cursor) {
        this.cursor = cursorNum;
        this.onCursor(this.cursor);
      }
    }
  }

  private parseRow(row: Record<string, unknown>): Record<string, unknown> {
    if (!this.query.jsonColumns || this.query.jsonColumns.length === 0) return row;
    const out: Record<string, unknown> = { ...row };
    for (const col of this.query.jsonColumns) {
      const val = out[col];
      if (typeof val === 'string' && val.trim().length > 0) {
        try {
          out[col] = JSON.parse(val);
        } catch {
          // keep raw
        }
      }
    }
    return out;
  }
}
