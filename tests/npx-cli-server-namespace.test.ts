import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const indexSource = readFileSync(join(__dirname, '..', 'src', 'npx-cli', 'index.ts'), 'utf-8');
const serverSource = readFileSync(join(__dirname, '..', 'src', 'npx-cli', 'commands', 'server.ts'), 'utf-8');
const workerServiceSource = readFileSync(join(__dirname, '..', 'src', 'services', 'worker-service.ts'), 'utf-8');

describe('npx CLI server namespace', () => {
  it('routes the server namespace through the server command module', () => {
    expect(indexSource).toContain("case 'server'");
    expect(indexSource).toContain("await import('./commands/server.js')");
    expect(indexSource).toContain('await runServerCommand(args.slice(1))');
  });

  it('routes worker lifecycle aliases through the server command module', () => {
    expect(indexSource).toContain("case 'worker'");
    expect(indexSource).toContain('runWorkerAliasCommand(args.slice(1))');
    expect(serverSource).toContain('runWorkerLifecycleCommand');
    expect(serverSource).toContain('runStartCommand()');
    expect(serverSource).toContain('runStopCommand()');
    expect(serverSource).toContain('runRestartCommand()');
    expect(serverSource).toContain('runStatusCommand()');
  });

  it('routes server lifecycle commands while keeping reserved commands nonzero failures', () => {
    expect(serverSource).toContain('runServerBetaLifecycleCommand(subCommand)');
    expect(serverSource).toContain('runServerBetaStartCommand()');
    expect(serverSource).toContain('runServerBetaStopCommand()');
    expect(serverSource).toContain('runServerBetaRestartCommand()');
    expect(serverSource).toContain('runServerBetaStatusCommand()');
    expect(serverSource).toContain("'logs'");
    expect(serverSource).toContain("'doctor'");
    expect(serverSource).toContain("'migrate'");
    expect(serverSource).toContain("'export'");
    expect(serverSource).toContain("'import'");
    expect(serverSource).toContain("process.exit(1)");
    expect(serverSource).toContain('runServerApiKeyCommand(argv.slice(1))');
    expect(serverSource).not.toContain('runServerLogsCommand');
  });

  it('normalizes direct worker-service server invocations', () => {
    expect(workerServiceSource).toContain("rawCommand === 'server'");
    expect(workerServiceSource).toContain('lifecycleCommands.has(maybeSubCommand)');
    expect(workerServiceSource).toContain('command: `server-${maybeSubCommand}`');
    expect(workerServiceSource).toContain("case 'server-start'");
    expect(workerServiceSource).toContain('runServerBetaServiceCli(command.slice');
    expect(workerServiceSource).toContain('serverCommands.has(maybeSubCommand)');
    expect(workerServiceSource).toContain("case 'server-api-key'");
    expect(workerServiceSource).toContain('runServerApiKeyCli(commandArgs)');
    expect(workerServiceSource).toContain("case 'server-help'");
    expect(workerServiceSource).toContain("case 'worker-help'");
    expect(workerServiceSource).not.toContain('command: maybeSubCommand ??');
  });
});
