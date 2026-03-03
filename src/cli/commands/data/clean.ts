import { Command } from 'commander';
import { cleanService } from '../../services/clean-service';
import { Logger } from '../../utils/logger';
import { formatBytes } from '../../utils/format';
import chalk from 'chalk';

export const cleanCommand = new Command('clean')
  .description('Clean up old data')
  .option('--sessions <days>', 'Delete sessions older than N days')
  .option('--observations <days>', 'Delete observations older than N days')
  .option('--logs <days>', 'Delete logs older than N days', '30')
  .option('--failed', 'Delete failed observations')
  .option('-d, --dry-run', 'Show what would be deleted without deleting')
  .option('-f, --force', 'Skip confirmation')
  .action(async (options) => {
    const logger = new Logger();

    // Parse options
    const cleanOptions = {
      sessions: options.sessions ? parseInt(options.sessions, 10) : undefined,
      observations: options.observations ? parseInt(options.observations, 10) : undefined,
      logs: options.logs ? parseInt(options.logs, 10) : undefined,
      failed: options.failed,
      dryRun: options.dryRun
    };

    // If no options specified, show help
    if (!cleanOptions.sessions && !cleanOptions.observations && !cleanOptions.logs && !cleanOptions.failed) {
      logger.error('No cleanup options specified');
      console.log('\nUsage examples:');
      console.log('  claude-mem clean --logs 30           # Delete logs older than 30 days');
      console.log('  claude-mem clean --sessions 90       # Delete sessions older than 90 days');
      console.log('  claude-mem clean --observations 60   # Delete observations older than 60 days');
      console.log('  claude-mem clean --failed            # Delete failed observations');
      console.log('  claude-mem clean --dry-run           # Preview what would be deleted');
      process.exit(1);
    }

    // Analyze
    logger.title('Analyzing cleanup...');
    const analysis = cleanService.analyze(cleanOptions);

    console.log(`  Sessions to delete:      ${analysis.sessions}`);
    console.log(`  Observations to delete:  ${analysis.observations}`);
    console.log(`  Log files to delete:     ${analysis.logs}`);
    console.log(`  Estimated space freed:   ${formatBytes(analysis.spaceEstimate)}`);

    if (options.dryRun) {
      console.log('\n' + chalk.gray('(Dry run - no changes made)'));
      return;
    }

    // Confirm
    if (!options.force) {
      const { confirm } = await require('inquirer').prompt([{
        type: 'confirm',
        name: 'confirm',
        message: chalk.yellow('Proceed with cleanup?'),
        default: false
      }]);

      if (!confirm) {
        logger.info('Cancelled');
        return;
      }
    }

    // Clean
    console.log('');
    logger.section('Cleaning...');

    const result = cleanService.clean(cleanOptions);

    if (result.errors.length > 0) {
      for (const error of result.errors) {
        logger.error(error);
      }
    }

    // Results
    logger.success('Cleanup complete!');
    if (result.sessionsDeleted) {
      console.log(`  Sessions deleted:      ${result.sessionsDeleted}`);
    }
    if (result.observationsDeleted) {
      console.log(`  Observations deleted:  ${result.observationsDeleted}`);
    }
    if (result.logsDeleted) {
      console.log(`  Log files deleted:     ${result.logsDeleted}`);
    }
    if (result.spaceFreed) {
      console.log(`  Space freed:           ${formatBytes(result.spaceFreed)}`);
    }
  });
