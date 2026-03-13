#!/usr/bin/env bun

import { Command } from 'commander';
import { doctorCommand, repairCommand, configCommand, shellCommand } from './commands/system';
import { logsCommand } from './commands/worker';
import { backupCommand, statsCommand, searchCommand, cleanCommand, exportCommand, importCommand } from './commands/data';

const program = new Command();

program
  .name('claude-mem')
  .description('Claude-Mem CLI - Manage your persistent memory')
  .version('10.5.2');

// System commands
program.addCommand(doctorCommand);
program.addCommand(repairCommand);
program.addCommand(configCommand);
program.addCommand(shellCommand);

// Worker commands
program.addCommand(logsCommand);

// Data commands
program.addCommand(backupCommand);
program.addCommand(statsCommand);
program.addCommand(searchCommand);
program.addCommand(cleanCommand);
program.addCommand(exportCommand);
program.addCommand(importCommand);

// Help examples
program.on('--help', () => {
  console.log('');
  console.log('System Commands:');
  console.log('  doctor           Run health checks');
  console.log('  repair           Fix common issues');
  console.log('  config           Manage settings (get/set/list/reset)');
  console.log('  shell            Shell completion setup');
  console.log('');
  console.log('Worker Commands:');
  console.log('  logs             View worker logs');
  console.log('');
  console.log('Data Commands:');
  console.log('  backup           Create backup');
  console.log('  stats            Show statistics');
  console.log('  search           Search memories');
  console.log('  clean            Clean up old data');
  console.log('  export           Export observations');
  console.log('  import           Import observations');
  console.log('');
  console.log('Documentation: https://docs.claude-mem.ai');
});

program.parse();
