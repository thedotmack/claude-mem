import { Command } from 'commander';
import { exportService } from '../../services/export-service';
import { Logger } from '../../utils/logger';
import { formatBytes } from '../../utils/format';
import { statSync } from 'fs';

export const exportCommand = new Command('export')
  .description('Export observations to file')
  .option('-f, --format <format>', 'Export format (json|markdown)', 'json')
  .option('-o, --output <path>', 'Output file path')
  .option('-p, --project <name>', 'Export only specific project')
  .option('--since <date>', 'Export since date (YYYY-MM-DD)')
  .action(async (options) => {
    const logger = new Logger();

    // Validate format
    if (!['json', 'markdown'].includes(options.format)) {
      logger.error(`Invalid format: ${options.format}. Use 'json' or 'markdown'`);
      process.exit(1);
    }

    // Generate output filename if not provided
    if (!options.output) {
      const timestamp = new Date().toISOString().slice(0, 10);
      const ext = options.format === 'json' ? 'json' : 'md';
      options.output = `claude-mem-export-${timestamp}.${ext}`;
    }

    // Parse since date
    let since: Date | undefined;
    if (options.since) {
      since = new Date(options.since);
      if (isNaN(since.getTime())) {
        logger.error(`Invalid date: ${options.since}`);
        process.exit(1);
      }
    }

    logger.title('Exporting Observations');
    console.log(`  Format: ${options.format}`);
    console.log(`  Output: ${options.output}`);
    if (options.project) console.log(`  Project: ${options.project}`);
    if (since) console.log(`  Since: ${since.toISOString().slice(0, 10)}`);
    console.log('');

    const result = exportService.export({
      format: options.format,
      output: options.output,
      project: options.project,
      since
    });

    if (!result.success) {
      logger.error(`Export failed: ${result.error}`);
      process.exit(1);
    }

    logger.success(`Exported ${result.count} observations`);

    const size = statSync(options.output).size;
    console.log(`  File: ${options.output}`);
    console.log(`  Size: ${formatBytes(size)}`);
  });
