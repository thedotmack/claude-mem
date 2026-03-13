import { Command } from 'commander';
import { healthChecker } from '../../services/health-check';
import { repairService } from '../../services/repair-service';
import { Logger } from '../../utils/logger';
import type { HealthCheckResult } from '../../types';

export const doctorCommand = new Command('doctor')
  .description('Run system health checks')
  .option('-f, --fix', 'Attempt to fix issues automatically')
  .option('-j, --json', 'Output results as JSON')
  .option('-v, --verbose', 'Show detailed information')
  .action(async (options) => {
    const logger = new Logger(options.verbose);

    if (options.json) {
      const results = await healthChecker.runAllChecks();
      console.log(JSON.stringify(results, null, 2));
      process.exit(0);
    }

    logger.title('Claude-Mem Health Check');
    console.log('Running checks...\n');

    const results = await healthChecker.runAllChecks();

    // Display results
    for (const result of results) {
      const icon = result.ok ? '✓' : result.severity === 'error' ? '✗' : '⚠';
      const color = result.ok ? 'green' : result.severity === 'error' ? 'red' : 'yellow';
      console.log(`  ${icon} ${result.name}: ${result.message}`);
    }

    // Summary
    const summary = healthChecker.getSummary(results);
    console.log('');
    if (summary.healthy && summary.warnings === 0) {
      logger.success('All systems operational!');
    } else if (summary.healthy) {
      logger.warning(`Healthy with ${summary.warnings} warning(s)`);
    } else {
      logger.error(`Found ${summary.errors} error(s)`);
    }

    // Auto-fix
    if (options.fix && summary.errors > 0) {
      console.log('');
      logger.section('Attempting automatic repair...');
      const repairs = await repairService.repairAll(results);
      for (const repair of repairs) {
        if (repair.fixed) logger.success(`${repair.issue}: ${repair.message}`);
        else logger.error(`${repair.issue}: ${repair.message}`);
      }
    }

    // Hint
    const fixable = results.filter(r => !r.ok && r.fixable && !options.fix).length;
    if (fixable > 0) {
      console.log('');
      logger.info(`Run 'claude-mem doctor --fix' to repair ${fixable} issue(s)`);
    }

    process.exit(summary.healthy ? 0 : 1);
  });
