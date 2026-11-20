#!/usr/bin/env node
// Stands in for a launcher found on PATH that exits before the CLI it starts. It runs the CLI that STAND_IN_LAUNCHER_RUNS
// names, with none of its own arguments, and has no SIGINT handler, so Node's default ends it at once on the stop that
// its whole process group is sent, while the CLI, sent the same stop, carries on. Two settings change it:
//   STAND_IN_LAUNCHER_SENDS_CLI_OUTPUT_TO: the CLI's stdout and stderr go to this file, not to the launcher's own, so the
//     CLI does not hold the output the launcher was started with.
//   STAND_IN_LAUNCHER_EXITS_AT_ONCE: it exits 0 as soon as the CLI has started, instead of waiting for it.
// Otherwise it waits for the CLI and exits with its code.
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';

const outputFile = process.env.STAND_IN_LAUNCHER_SENDS_CLI_OUTPUT_TO;
const output = outputFile ? openSync(outputFile, 'a') : 'inherit';
const cli = spawn(process.env.STAND_IN_LAUNCHER_RUNS, [], { stdio: ['inherit', output, output] });
if (process.env.STAND_IN_LAUNCHER_EXITS_AT_ONCE) cli.on('spawn', () => process.exit(0));
else cli.on('exit', code => process.exit(code ?? 1));
