import Database from 'bun:sqlite';
import { DB_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

export async function runMergeEnvironmentCommand(args: string[]): Promise<void> {
  // Parse --name=VALUE and --from=VALUE1,VALUE2,...
  const nameArg = args.find(a => a.startsWith('--name='))?.split('=')[1] ?? '';
  const fromArg = args.find(a => a.startsWith('--from='))?.split('=')[1] ?? '';
  const fromProjects = fromArg ? fromArg.split(',').map(p => p.trim()).filter(Boolean) : [];

  if (!nameArg || nameArg.trim() === '') {
    console.error('Error: --name is required and cannot be empty');
    console.error('Usage: npx claude-mem merge-environment --name=<env-name> --from=<project1,project2,...>');
    process.exit(1);
  }

  if (fromProjects.length === 0) {
    console.error('Error: --from is required (comma-separated project names)');
    console.error('Usage: npx claude-mem merge-environment --name=<env-name> --from=<project1,project2,...>');
    process.exit(1);
  }

  logger.info('ENV', 'Starting migration', { targetName: nameArg, sourceProjects: fromProjects });

  const db = new Database(DB_PATH, { create: true, readwrite: true });

  const updates: Array<{ table: string; column: string }> = [
    { table: 'observations', column: 'project' },
    { table: 'observations', column: 'merged_into_project' },
    { table: 'session_summaries', column: 'project' },
    { table: 'session_summaries', column: 'merged_into_project' },
    { table: 'sdk_sessions', column: 'project' },
  ];

  let totalUpdated = 0;

  for (const { table, column } of updates) {
    const placeholders = fromProjects.map(() => '?').join(',');
    const sql = `UPDATE ${table} SET ${column} = ? WHERE ${column} IN (${placeholders})`;

    try {
      const stmt = db.prepare(sql);
      const result = stmt.run(nameArg, ...fromProjects);
      totalUpdated += result.changes;
      logger.info('ENV', `Updated ${table}.${column}`, { changes: result.changes });
    } catch (err) {
      // Column may not exist yet (e.g. merged_into_project before migration runs)
      logger.error('ENV', `Failed to update ${table}.${column}`, { error: String(err) });
    }
  }

  db.close();

  console.log(`\nMigration complete: ${totalUpdated} rows updated.`);
  console.log(`\nWorker restart required for Chroma resync.`);
  console.log(`Run: npx claude-mem start`);
  console.log(`(or restart your worker service manually)`);
}