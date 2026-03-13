import { Command } from 'commander';
import { importService } from '../../services/import-service';
import { Logger } from '../../utils/logger';

export const importCommand = new Command('import')
  .description('Import observations from file')
  .argument('<file>', 'JSON file to import')
  .option('-d, --dry-run', 'Validate without importing')
  .option('-f, --force', 'Skip confirmation')
  .action(async (file, options) => {
    const logger = new Logger();

    // Validate
    logger.title('Validating Import File');
    const validation = importService.validate(file);

    if (!validation.valid) {
      logger.error('Validation failed:');
      for (const error of validation.errors) {
        console.log(`  • ${error}`);
      }
      process.exit(1);
    }

    logger.success(`File is valid (${validation.count} observations)`);

    if (options.dryRun) {
      logger.info('Dry run - no changes made');
      return;
    }

    // Confirm
    if (!options.force) {
      const { confirm } = await require('inquirer').prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Import ${validation.count} observations?`,
        default: false
      }]);

      if (!confirm) {
        logger.info('Cancelled');
        return;
      }
    }

    // Import
    console.log('');
    logger.section('Importing...');

    const result = importService.importJSON(file);

    if (result.success) {
      logger.success(`Imported ${result.imported} observations`);
    } else {
      logger.error('Import failed:');
      for (const error of result.errors) {
        console.log(`  • ${error}`);
      }
      process.exit(1);
    }
  });
