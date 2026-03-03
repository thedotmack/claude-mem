import { Command } from 'commander';
import { healthChecker } from '../../services/health-check';
import { repairService } from '../../services/repair-service';
import { Logger } from '../../utils/logger';

export const repairCommand = new Command('repair')
  .description('Automatically fix common issues')
  .option('-d, --dry-run', 'Show what would be fixed without making changes')
  .option('-f, --force', 'Skip confirmation prompts')
  .action(async (options) => {
    const logger = new Logger();
    logger.title('Claude-Mem Auto-Repair');

    // Diagnose
    logger.section('Diagnosing issues...');
    const checks = await healthChecker.runAllChecks();
    const issues = checks.filter(c => !c.ok && c.fixable);

    if (issues.length === 0) {
      logger.success('No fixable issues found!');
      return;
    }

    console.log(`\nFound ${issues.length} issue(s):`);
    for (const issue of issues) {
      console.log(`  • ${issue.name}: ${issue.message}`);
    }

    if (options.dryRun) {
      console.log('\n(Dry-run mode - no changes made)');
      return;
    }

    // Apply fixes
    console.log('');
    logger.section('Applying fixes...');
    const repairs = await repairService.repairAll(checks);

    let fixed = 0;
    for (const repair of repairs) {
      if (repair.fixed) {
        logger.success(`${repair.issue}: ${repair.message}`);
        fixed++;
      } else {
        logger.error(`${repair.issue}: ${repair.message}`);
      }
    }

    // Result
    console.log('');
    if (fixed === issues.length) {
      logger.success('All issues resolved!');
    } else {
      logger.warning(`${fixed}/${issues.length} issue(s) fixed`);
    }
  });
