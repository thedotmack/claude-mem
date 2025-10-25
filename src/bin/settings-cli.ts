/**
 * Settings CLI - Command-line interface for managing claude-mem settings
 *
 * Usage:
 *   settings-cli                           # Show current settings (formatted)
 *   settings-cli --json                    # Show current settings (JSON)
 *   settings-cli --get <key>               # Get specific setting value
 *   settings-cli --set <key>=<value>       # Set specific setting
 *   settings-cli --reset                   # Reset to defaults
 *   settings-cli --help                    # Show help
 */

import { getSettings, type Settings, type ModelOption } from '../services/settings-service.js';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
};

function printHelp(): void {
  console.log(`
${COLORS.bright}claude-mem settings${COLORS.reset}

${COLORS.cyan}USAGE${COLORS.reset}
  settings-cli                           Show current settings (formatted)
  settings-cli --json                    Show current settings (JSON)
  settings-cli --get <key>               Get specific setting value
  settings-cli --set <key>=<value>       Set specific setting
  settings-cli --reset                   Reset to defaults
  settings-cli --help                    Show this help

${COLORS.cyan}SETTINGS${COLORS.reset}
  ${COLORS.green}model${COLORS.reset}                   AI model for processing observations
                              Options: claude-haiku-4-5, claude-sonnet-4-5,
                                       claude-opus-4, claude-3-7-sonnet
                              Default: claude-sonnet-4-5

  ${COLORS.green}workerPort${COLORS.reset}              Port for worker service HTTP API
                              Range: 1-65535
                              Default: 37777

  ${COLORS.green}enableMemoryStorage${COLORS.reset}     Enable/disable saving observations to database
                              Options: true, false
                              Default: true

  ${COLORS.green}enableContextInjection${COLORS.reset}  Enable/disable context injection at session start
                              Options: true, false
                              Default: true

  ${COLORS.green}contextDepth${COLORS.reset}            Number of recent sessions to load in context
                              Range: 1-50
                              Default: 5
                              Higher = more history, more tokens

${COLORS.cyan}EXAMPLES${COLORS.reset}
  ${COLORS.dim}# View current settings${COLORS.reset}
  settings-cli

  ${COLORS.dim}# Change model to haiku${COLORS.reset}
  settings-cli --set model=claude-haiku-4-5

  ${COLORS.dim}# Disable memory storage${COLORS.reset}
  settings-cli --set enableMemoryStorage=false

  ${COLORS.dim}# Set context depth to 10${COLORS.reset}
  settings-cli --set contextDepth=10

  ${COLORS.dim}# Get specific setting${COLORS.reset}
  settings-cli --get model

  ${COLORS.dim}# JSON output (for scripts)${COLORS.reset}
  settings-cli --json

${COLORS.cyan}FILES${COLORS.reset}
  Settings: ${COLORS.gray}~/.claude-mem/settings.json${COLORS.reset}
`);
}

function formatValue(value: any): string {
  if (typeof value === 'boolean') {
    return value ? `${COLORS.green}${value}${COLORS.reset}` : `${COLORS.red}${value}${COLORS.reset}`;
  }
  if (typeof value === 'number') {
    return `${COLORS.yellow}${value}${COLORS.reset}`;
  }
  if (typeof value === 'string') {
    return `${COLORS.cyan}${value}${COLORS.reset}`;
  }
  return String(value);
}

function printSettings(withDescriptions: boolean = true): void {
  const service = getSettings();
  const settingsPath = service.getPath();
  const exists = existsSync(settingsPath);

  console.log(`\n${COLORS.bright}${COLORS.cyan}Claude-Mem Settings${COLORS.reset}`);
  console.log(`${COLORS.gray}${'─'.repeat(60)}${COLORS.reset}\n`);

  if (!exists) {
    console.log(`${COLORS.yellow}⚠ Settings file not found${COLORS.reset}`);
    console.log(`  ${COLORS.dim}Will be created at: ${settingsPath}${COLORS.reset}`);
    console.log(`  ${COLORS.dim}Using default values${COLORS.reset}\n`);
  } else {
    console.log(`${COLORS.dim}Settings file: ${settingsPath}${COLORS.reset}\n`);
  }

  if (withDescriptions) {
    const settingsWithDesc = service.getWithDescriptions();

    console.log(`${COLORS.bright}model${COLORS.reset}: ${formatValue(settingsWithDesc.model.value)}`);
    console.log(`  ${COLORS.dim}${settingsWithDesc.model.description}${COLORS.reset}`);
    console.log(`  ${COLORS.dim}Options: ${settingsWithDesc.model.options.join(', ')}${COLORS.reset}\n`);

    console.log(`${COLORS.bright}workerPort${COLORS.reset}: ${formatValue(settingsWithDesc.workerPort.value)}`);
    console.log(`  ${COLORS.dim}${settingsWithDesc.workerPort.description}${COLORS.reset}\n`);

    console.log(`${COLORS.bright}enableMemoryStorage${COLORS.reset}: ${formatValue(settingsWithDesc.enableMemoryStorage.value)}`);
    console.log(`  ${COLORS.dim}${settingsWithDesc.enableMemoryStorage.description}${COLORS.reset}\n`);

    console.log(`${COLORS.bright}enableContextInjection${COLORS.reset}: ${formatValue(settingsWithDesc.enableContextInjection.value)}`);
    console.log(`  ${COLORS.dim}${settingsWithDesc.enableContextInjection.description}${COLORS.reset}\n`);

    console.log(`${COLORS.bright}contextDepth${COLORS.reset}: ${formatValue(settingsWithDesc.contextDepth.value)}`);
    console.log(`  ${COLORS.dim}${settingsWithDesc.contextDepth.description}${COLORS.reset}\n`);
  } else {
    const settings = service.get();
    for (const [key, value] of Object.entries(settings)) {
      console.log(`${COLORS.bright}${key}${COLORS.reset}: ${formatValue(value)}`);
    }
    console.log();
  }

  console.log(`${COLORS.gray}${'─'.repeat(60)}${COLORS.reset}`);
  console.log(`${COLORS.dim}Run 'settings-cli --help' for usage information${COLORS.reset}\n`);
}

function getSetting(key: string): void {
  const service = getSettings();
  const settings = service.get();

  if (!(key in settings)) {
    console.error(`${COLORS.red}Error: Unknown setting '${key}'${COLORS.reset}`);
    console.error(`${COLORS.dim}Valid settings: ${Object.keys(settings).join(', ')}${COLORS.reset}`);
    process.exit(1);
  }

  const value = (settings as any)[key];
  console.log(JSON.stringify(value));
}

function setSetting(keyValue: string): void {
  const [key, ...valueParts] = keyValue.split('=');
  const value = valueParts.join('='); // In case value contains '='

  if (!key || value === undefined || value === '') {
    console.error(`${COLORS.red}Error: Invalid format. Use --set key=value${COLORS.reset}`);
    process.exit(1);
  }

  const service = getSettings();
  const settings = service.get();

  if (!(key in settings)) {
    console.error(`${COLORS.red}Error: Unknown setting '${key}'${COLORS.reset}`);
    console.error(`${COLORS.dim}Valid settings: ${Object.keys(settings).join(', ')}${COLORS.reset}`);
    process.exit(1);
  }

  // Parse value based on type
  let parsedValue: any;
  const currentType = typeof (settings as any)[key];

  if (currentType === 'boolean') {
    if (value === 'true') parsedValue = true;
    else if (value === 'false') parsedValue = false;
    else {
      console.error(`${COLORS.red}Error: '${key}' must be true or false${COLORS.reset}`);
      process.exit(1);
    }
  } else if (currentType === 'number') {
    parsedValue = parseInt(value, 10);
    if (isNaN(parsedValue)) {
      console.error(`${COLORS.red}Error: '${key}' must be a number${COLORS.reset}`);
      process.exit(1);
    }
  } else {
    parsedValue = value;
  }

  try {
    service.set({ [key]: parsedValue } as Partial<Settings>);
    console.log(`${COLORS.green}✓${COLORS.reset} Updated ${COLORS.bright}${key}${COLORS.reset} = ${formatValue(parsedValue)}`);
  } catch (error: any) {
    console.error(`${COLORS.red}Error: ${error.message}${COLORS.reset}`);
    process.exit(1);
  }
}

function resetSettings(): void {
  const service = getSettings();
  service.reset();
  console.log(`${COLORS.green}✓${COLORS.reset} Settings reset to defaults`);
  printSettings(false);
}

function printJSON(): void {
  const service = getSettings();
  const settings = service.get();
  console.log(JSON.stringify(settings, null, 2));
}

// Main
const args = process.argv.slice(2);

if (args.length === 0) {
  // No args - show formatted settings
  printSettings(true);
  process.exit(0);
}

const flag = args[0];

switch (flag) {
  case '--help':
  case '-h':
    printHelp();
    break;

  case '--json':
    printJSON();
    break;

  case '--get':
    if (args.length < 2) {
      console.error(`${COLORS.red}Error: --get requires a key${COLORS.reset}`);
      process.exit(1);
    }
    getSetting(args[1]);
    break;

  case '--set':
    if (args.length < 2) {
      console.error(`${COLORS.red}Error: --set requires key=value${COLORS.reset}`);
      process.exit(1);
    }
    setSetting(args[1]);
    break;

  case '--reset':
    resetSettings();
    break;

  default:
    console.error(`${COLORS.red}Error: Unknown flag '${flag}'${COLORS.reset}`);
    console.error(`${COLORS.dim}Run 'settings-cli --help' for usage${COLORS.reset}`);
    process.exit(1);
}
