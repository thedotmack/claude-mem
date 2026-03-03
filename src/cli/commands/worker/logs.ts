import { Command } from 'commander';
import { logService } from '../../services/log-service';
import { Logger } from '../../utils/logger';
import { formatBytes } from '../../utils/format';
import chalk from 'chalk';

export const logsCommand = new Command('logs')
  .description('View and manage worker logs')
  .option('-t, --tail <n>', 'Show last N lines', '50')
  .option('-f, --follow', 'Follow log output in real-time')
  .option('-l, --level <level>', 'Filter by level (DEBUG|INFO|WARN|ERROR)')
  .option('-s, --session <id>', 'Filter by session ID')
  .option('-d, --date <date>', 'Show logs for specific date (YYYY-MM-DD)')
  .option('--list', 'List available log files')
  .option('--clean [days]', 'Clean logs older than N days (default: 30)', '0')
  .action(async (options) => {
    const logger = new Logger();

    // List log files
    if (options.list) {
      const files = logService.getLogFiles();
      logger.title('Available Log Files');
      
      if (files.length === 0) {
        logger.info('No log files found');
        return;
      }

      for (const file of files.slice(0, 10)) {
        console.log(`  ${file.date}  ${formatBytes(file.size).padStart(8)}  ${file.name}`);
      }

      const totalSize = logService.getTotalSize();
      console.log(`\n  Total: ${files.length} files, ${formatBytes(totalSize)}`);
      return;
    }

    // Clean old logs
    if (parseInt(options.clean) > 0) {
      const days = parseInt(options.clean);
      logger.title(`Cleaning logs older than ${days} days...`);
      
      const result = logService.cleanOldLogs(days);
      logger.success(`Deleted ${result.deleted} files, freed ${formatBytes(result.freed)}`);
      return;
    }

    // Get log file path
    const logFile = options.date 
      ? `${logService['logsDir']}/worker-${options.date}.log`
      : undefined;

    // Follow mode
    if (options.follow) {
      logger.title('Following logs (Press Ctrl+C to exit)');
      console.log('');

      for await (const entry of logService.followLogs(logFile)) {
        printLogEntry(entry, options.level);
      }
      return;
    }

    // Read logs
    const tail = parseInt(options.tail) || 50;
    const filter = {
      level: options.level,
      session: options.session
    };

    const entries = await logService.readLogs({ 
      tail, 
      file: logFile,
      filter: options.level || options.session ? filter : undefined
    });

    if (entries.length === 0) {
      logger.info('No logs found');
      return;
    }

    // Print entries
    for (const entry of entries) {
      printLogEntry(entry);
    }

    console.log(`\n  Showing ${entries.length} lines`);
  });

function printLogEntry(entry: { timestamp: string; level: string; component: string; message: string }, filterLevel?: string) {
  if (filterLevel && entry.level !== filterLevel) return;

  const levelColor = {
    'DEBUG': chalk.gray,
    'INFO': chalk.blue,
    'WARN': chalk.yellow,
    'ERROR': chalk.red,
    'UNKNOWN': chalk.gray
  }[entry.level] || chalk.gray;

  const time = entry.timestamp ? chalk.gray(entry.timestamp.split(' ')[1].slice(0, 8)) : '';
  const level = levelColor(entry.level.padStart(5));
  const component = chalk.cyan(entry.component);
  
  console.log(`${time} ${level} [${component}] ${entry.message}`);
}
