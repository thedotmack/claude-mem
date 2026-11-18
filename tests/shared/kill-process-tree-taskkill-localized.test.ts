import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { handleTaskkillFailure, ProcessTreeKillError } from '../../src/shared/kill-process-tree.js';

/**
 * taskkill prints its failure reason in the Windows display language. When the
 * `/T` walk meets a child that already exited, it exits 255, and on a
 * Portuguese install the reason reads "Não há ocorrência da tarefa em
 * execução", which the English not-found pattern does not match. The
 * classification is a plain function of the PID and the error, so it is
 * checked here on every platform.
 */

/** A PID that belonged to a process which has exited. */
function exitedPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid!;
}

function taskkillError(code: number, stderr: string): Error {
  return Object.assign(new Error(`Command failed: taskkill\n${stderr}`), { code, stderr });
}

describe('handleTaskkillFailure', () => {
  it('treats a localized exit 255 as already gone when the root and every named PID have exited', async () => {
    const root = exitedPid();
    const child = exitedPid();

    await handleTaskkillFailure(root, taskkillError(
      255,
      `ERRO: o processo com PID ${child} (processo filho do PID ${root}) não pôde ser finalizado.\r\nMotivo: Não há ocorrência da tarefa em execução.\r\n`,
    ));
  });

  it('reads the PIDs when the reason text is not readable', async () => {
    const root = exitedPid();
    const child = exitedPid();

    await handleTaskkillFailure(root, taskkillError(
      255,
      `�� PID ${child} (�� PID ${root}) ��.\r\n`,
    ));
  });

  it('treats the root\'s own live parent as outside the tree (the event this fix is for)', async () => {
    // The worker spawns the root, so taskkill names the live worker as the root's parent.
    const root = exitedPid();

    await handleTaskkillFailure(root, taskkillError(
      255,
      `ERRO: o processo com PID ${root} (processo filho de PID ${process.pid}) não pôde ser finalizado.\r\nRazão: Não há ocorrência da tarefa em execução.\r\n`,
    ));
  });

  it('still throws on exit 255 when a named PID is alive (access denied)', async () => {
    const root = exitedPid();

    const handled = handleTaskkillFailure(root, taskkillError(
      255,
      `ERRO: o processo com PID ${process.pid} (processo filho de PID ${root}) não pôde ser finalizado.\r\nMotivo: Acesso negado.\r\n`,
    ));

    await expect(handled).rejects.toBeInstanceOf(ProcessTreeKillError);
  });

  it('still throws on exit 255 when the root is alive', async () => {
    const handled = handleTaskkillFailure(process.pid, taskkillError(255, ''));

    await expect(handled).rejects.toBeInstanceOf(ProcessTreeKillError);
  });

  it('does not apply the liveness check to other exit codes', async () => {
    const root = exitedPid();

    const handled = handleTaskkillFailure(root, taskkillError(
      1,
      `ERRO: o processo com PID ${root} não pôde ser finalizado.\r\nMotivo: Acesso negado.\r\n`,
    ));

    await expect(handled).rejects.toBeInstanceOf(ProcessTreeKillError);
  });

  it('keeps exit 128 as already gone', async () => {
    await handleTaskkillFailure(exitedPid(), taskkillError(128, ''));
  });
});
