import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ContainerManager } from '../container-manager.js';
import type { Manifest } from '../types.js';
import { readAgentState } from './state-reader.js';
import type { AgentState } from './state-reader.js';
import { evaluateDrift } from './drift-evaluator.js';
import type { DriftAssessment } from './drift-evaluator.js';
import { TelegramNotifier } from './telegram-notifier.js';
import { KillHandler } from './kill-handler.js';

// --- Error Classes ---

export class JudgeManifestNotFoundError extends Error {
  constructor(public readonly manifestPath: string) {
    super(`Judge manifest not found at ${manifestPath}`);
    this.name = 'JudgeManifestNotFoundError';
  }
}

export class JudgeCycleError extends Error {
  constructor(
    public readonly cycleNumber: number,
    public readonly reason: string,
  ) {
    super(`Judge cycle #${cycleNumber} failed: ${reason}`);
    this.name = 'JudgeCycleError';
  }
}

// --- Config ---

interface JudgeConfig {
  resultsDir: string;
  manifestPath: string;
  keysEnvPath: string;
  intervalMs: number;
}

function parseJudgeConfig(): JudgeConfig {
  const { values } = parseArgs({
    options: {
      'results-dir': { type: 'string', default: './results' },
      manifest: { type: 'string', default: './results/manifest.json' },
      'keys-env': { type: 'string', default: './keys.env' },
      interval: { type: 'string', default: '600000' },
    },
    strict: false,
  });

  return {
    resultsDir: values['results-dir'] as string,
    manifestPath: values['manifest'] as string,
    keysEnvPath: values['keys-env'] as string,
    intervalMs: Number(values['interval']),
  };
}

// --- Manifest Loader ---

async function loadManifest(manifestPath: string): Promise<Manifest> {
  let content: string;
  try {
    content = await readFile(manifestPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new JudgeManifestNotFoundError(manifestPath);
    }
    throw error;
  }

  return JSON.parse(content) as Manifest;
}

// --- Key Loader (minimal, just extracts Telegram credentials) ---

async function loadTelegramCredentials(
  keysEnvPath: string,
): Promise<{ botToken: string; chatId: string }> {
  const content = await readFile(keysEnvPath, 'utf-8');
  const lines = content.split('\n');

  let botToken = '';
  let chatId = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;

    const eqIndex = trimmed.indexOf('=');
    const key = trimmed.slice(0, eqIndex);
    const value = trimmed.slice(eqIndex + 1);

    if (key === 'TELEGRAM_BOT_TOKEN') botToken = value;
    if (key === 'TELEGRAM_CHAT_ID') chatId = value;
  }

  return { botToken, chatId };
}

// --- Heartbeat ---

async function writeHeartbeat(resultsDir: string): Promise<void> {
  const heartbeatPath = join(resultsDir, '.judge-heartbeat');
  await writeFile(heartbeatPath, new Date().toISOString());
}

// --- Judge Log ---

async function appendJudgeLog(
  resultsDir: string,
  agentId: string,
  assessment: DriftAssessment,
): Promise<void> {
  const logPath = join(resultsDir, agentId, 'judge-log.jsonl');
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...assessment,
  });

  const { appendFile } = await import('node:fs/promises');
  await appendFile(logPath, entry + '\n');
}

// --- Elapsed Formatter ---

function formatElapsedSinceStart(startedAt: string): string {
  const startTime = new Date(startedAt);
  const now = new Date();
  const totalSeconds = (now.getTime() - startTime.getTime()) / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

// --- Main Judge Loop ---

async function runJudgeCycle(
  cycleNumber: number,
  manifest: Manifest,
  resultsDir: string,
  containerManager: ContainerManager,
  notifier: TelegramNotifier | null,
  killHandler: KillHandler | null,
): Promise<void> {
  console.log(`\n--- Judge Cycle #${cycleNumber} ---`);

  const states: AgentState[] = [];
  const assessments: DriftAssessment[] = [];

  for (const agent of manifest.agents) {
    try {
      const startTime = new Date(agent.start_time);
      const agentState = await readAgentState(
        agent.agent_id,
        resultsDir,
        startTime,
      );

      // Try to get real container status from Docker
      try {
        const dockerStatus = await containerManager.getContainerStatus(
          agent.container_id,
        );
        agentState.containerStatus = dockerStatus;
      } catch {
        // Container may have been removed; rely on file-based status
      }

      states.push(agentState);

      const assessment = evaluateDrift(agentState);
      assessments.push(assessment);

      // Write to judge log
      await appendJudgeLog(resultsDir, agent.agent_id, assessment);

      console.log(
        `  ${agent.agent_id}: ${assessment.score} (${assessment.stage}) — ${assessment.reasoning}`,
      );
    } catch (error) {
      console.error(
        `  ${agent.agent_id}: ERROR — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Update kill handler state snapshot before polling
  if (killHandler) {
    killHandler.updateStateSnapshot(states, assessments);
  }

  // Send Telegram summary
  if (notifier) {
    try {
      const elapsed = formatElapsedSinceStart(manifest.started_at);
      await notifier.sendCycleSummary(cycleNumber, elapsed, states, assessments);
      console.log('  Telegram summary sent.');
    } catch (error) {
      console.error(
        `  Telegram send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Poll for incoming Telegram commands
  if (killHandler) {
    try {
      await killHandler.pollCommands();
    } catch (error) {
      console.error(
        `  Telegram poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Write heartbeat
  await writeHeartbeat(resultsDir);

  // Summary
  const doneCount = states.filter((s) => s.isDone).length;
  const totalAgents = manifest.agents.length;
  console.log(
    `  Cycle #${cycleNumber} complete. ${doneCount}/${totalAgents} agents done.`,
  );
}

async function main(): Promise<void> {
  const config = parseJudgeConfig();

  console.log('Judge runner starting');
  console.log(`  Results dir: ${config.resultsDir}`);
  console.log(`  Manifest: ${config.manifestPath}`);
  console.log(`  Interval: ${config.intervalMs}ms`);

  // Load manifest
  const manifest = await loadManifest(config.manifestPath);
  console.log(`  Loaded manifest with ${manifest.agents.length} agents`);

  // Load Telegram credentials (optional — runs without if not configured)
  let notifier: TelegramNotifier | null = null;
  let killHandler: KillHandler | null = null;

  try {
    const telegramCreds = await loadTelegramCredentials(config.keysEnvPath);
    if (telegramCreds.botToken && telegramCreds.chatId) {
      notifier = new TelegramNotifier(
        telegramCreds.botToken,
        telegramCreds.chatId,
      );
      const containerManager = new ContainerManager();
      killHandler = new KillHandler(
        telegramCreds.botToken,
        containerManager,
        config.resultsDir,
        telegramCreds.chatId,
      );
      console.log('  Telegram notifications enabled');
    } else {
      console.log('  Telegram credentials not found; running without notifications');
    }
  } catch {
    console.log('  Could not load Telegram credentials; running without notifications');
  }

  const containerManager = new ContainerManager();
  let cycleNumber = 0;

  // Run first cycle immediately
  cycleNumber++;
  try {
    await runJudgeCycle(
      cycleNumber,
      manifest,
      config.resultsDir,
      containerManager,
      notifier,
      killHandler,
    );
  } catch (error) {
    console.error(
      `Judge cycle #${cycleNumber} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Schedule recurring cycles
  setInterval(async () => {
    cycleNumber++;
    try {
      // Re-read manifest each cycle in case it was updated
      const freshManifest = await loadManifest(config.manifestPath);
      await runJudgeCycle(
        cycleNumber,
        freshManifest,
        config.resultsDir,
        containerManager,
        notifier,
        killHandler,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(new JudgeCycleError(cycleNumber, reason).message);
    }
  }, config.intervalMs);

  console.log(
    `Judge running. Next cycle in ${config.intervalMs / 1000} seconds.`,
  );
}

// Export for testing
export {
  loadManifest,
  loadTelegramCredentials,
  runJudgeCycle,
  parseJudgeConfig,
  formatElapsedSinceStart,
};

main().catch((error: Error) => {
  console.error(`Fatal: ${error.name}: ${error.message}`);
  process.exit(1);
});
