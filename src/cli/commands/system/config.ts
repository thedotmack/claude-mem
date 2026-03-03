import { Command } from 'commander';
import { configService, DEFAULT_SETTINGS } from '../../services/config-service';
import { Logger } from '../../utils/logger';
import chalk from 'chalk';

export const configCommand = new Command('config')
  .description('Manage claude-mem settings')
  .addCommand(
    new Command('get')
      .description('Get a setting value')
      .argument('<key>', 'Setting key')
      .action((key) => {
        const value = configService.get(key);
        if (value !== undefined) {
          console.log(value);
        } else {
          console.error(`Setting not found: ${key}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('set')
      .description('Set a setting value')
      .argument('<key>', 'Setting key')
      .argument('<value>', 'Setting value')
      .action((key, value) => {
        const logger = new Logger();
        
        // Validate setting before setting
        const validationError = validateSetting(key, value);
        if (validationError) {
          logger.error(`Invalid value: ${validationError}`);
          process.exit(1);
        }
        
        if (configService.set(key, value)) {
          logger.success(`Set ${key} = ${value}`);
          
          // Warn if restart needed
          if (key === 'CLAUDE_MEM_WORKER_PORT') {
            logger.info('Restart worker for changes to take effect: claude-mem restart');
          }
        } else {
          logger.error(`Failed to set ${key}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('list')
      .description('List all settings')
      .option('--defaults', 'Show default values')
      .action((options) => {
        const logger = new Logger();
        const settings = configService.getSettings();

        logger.title('Claude-Mem Settings');
        console.log(`  File: ${require('../../utils/paths').paths.claudeMemSettings}\n`);

        for (const def of DEFAULT_SETTINGS) {
          const current = settings[def.key];
          const isDefault = current === def.defaultValue;
          const marker = isDefault ? chalk.gray('○') : chalk.green('●');
          
          console.log(`${marker} ${chalk.cyan(def.key)}`);
          console.log(`  Value: ${chalk.yellow(current || def.defaultValue)}`);
          console.log(`  Description: ${def.description}`);
          if (!isDefault && options.defaults) {
            console.log(`  Default: ${def.defaultValue}`);
          }
          console.log('');
        }
      })
  )
  .addCommand(
    new Command('reset')
      .description('Reset all settings to defaults')
      .option('-f, --force', 'Skip confirmation')
      .action(async (options) => {
        const logger = new Logger();

        if (!options.force) {
          const { confirm } = await require('inquirer').prompt([{
            type: 'confirm',
            name: 'confirm',
            message: 'Reset all settings to defaults?',
            default: false
          }]);

          if (!confirm) {
            logger.info('Cancelled');
            return;
          }
        }

        configService.reset();
        logger.success('Settings reset to defaults');
      })
  )
  .addCommand(
    new Command('validate')
      .description('Validate current settings')
      .action(() => {
        const logger = new Logger();
        const result = configService.validate();

        if (result.valid) {
          logger.success('All settings are valid');
        } else {
          logger.error('Validation failed:');
          for (const error of result.errors) {
            console.log(`  • ${error}`);
          }
          process.exit(1);
        }
      })
  );

/**
 * Validate a setting value before setting
 * Returns error message if invalid, null if valid
 */
function validateSetting(key: string, value: string): string | null {
  switch (key) {
    case 'CLAUDE_MEM_WORKER_PORT': {
      const port = parseInt(value, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        return `Port must be a number between 1024 and 65535 (got: ${value})`;
      }
      return null;
    }
    
    case 'CLAUDE_MEM_LOG_LEVEL': {
      const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
      if (!validLevels.includes(value)) {
        return `Log level must be one of: ${validLevels.join(', ')} (got: ${value})`;
      }
      return null;
    }
    
    case 'CLAUDE_MEM_CONTEXT_OBSERVATIONS': {
      const count = parseInt(value, 10);
      if (isNaN(count) || count < 1 || count > 500) {
        return `Observation count must be between 1 and 500 (got: ${value})`;
      }
      return null;
    }
    
    case 'CLAUDE_MEM_PROVIDER': {
      const validProviders = ['claude', 'gemini', 'openrouter'];
      if (!validProviders.includes(value)) {
        return `Provider must be one of: ${validProviders.join(', ')} (got: ${value})`;
      }
      return null;
    }
    
    default:
      // Unknown setting - allow but warn
      return null;
  }
}
