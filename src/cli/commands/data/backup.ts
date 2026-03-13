import { Command } from 'commander';
import { backupService } from '../../services/backup-service';
import { Logger } from '../../utils/logger';
import { formatBytes } from '../../utils/format';

export const backupCommand = new Command('backup')
  .description('Create backup of data and settings')
  .option('-o, --output <path>', 'Output file path')
  .option('--database-only', 'Backup only the database')
  .option('--settings-only', 'Backup only settings')
  .option('--list', 'List available backups')
  .action(async (options) => {
    const logger = new Logger();

    // List backups
    if (options.list) {
      const backups = backupService.listBackups();
      logger.title('Available Backups');

      if (backups.length === 0) {
        logger.info('No backups found');
        return;
      }

      for (const backup of backups.slice(0, 10)) {
        console.log(`  ${backup.date.toISOString().slice(0, 19)}  ${formatBytes(backup.size).padStart(8)}  ${backup.name}`);
      }
      return;
    }

    // Create backup
    logger.title('Creating Backup');
    logger.info('This may take a moment...');
    console.log('');

    const result = await backupService.createBackup({
      output: options.output,
      databaseOnly: options.databaseOnly,
      settingsOnly: options.settingsOnly
    });

    if (!result.success) {
      logger.error(`Backup failed: ${result.error}`);
      process.exit(1);
    }

    logger.success('Backup created successfully!');
    console.log(`\n  Path: ${result.path}`);
    console.log(`  Size: ${formatBytes(result.size || 0)}`);
    console.log(`  Files: ${result.files.length}`);
  });
