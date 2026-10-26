#!/usr/bin/env bun
/**
 * Read-only dry run of the setup prompt scan: counts the owner's typed prompts
 * per agent and writes nothing anywhere (no DB, no files).
 *
 *   bun src/services/prompt-import/cli.ts [--days 30 | --since <ISO or epoch ms>] [--agents claude-code,codex]
 */

import { scanOwnerPrompts, scanWindowStart, PROMPT_SCAN_WINDOW_DAYS, type PromptAgentId } from './index.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const since = argument('since');
const sinceEpochMs = since
  ? (/^\d+$/.test(since) ? Number(since) : Date.parse(since))
  : scanWindowStart(Date.now(), Number(argument('days') ?? PROMPT_SCAN_WINDOW_DAYS));
if (!Number.isFinite(sinceEpochMs)) throw new Error(`--since is not a date: ${since}`);
const agents = argument('agents')?.split(',') as PromptAgentId[] | undefined;

const startedAt = Date.now();
const result = await scanOwnerPrompts({ sinceEpochMs, agents, resolveProject: cwd => cwd ?? 'unknown' });
const byAgent = Object.fromEntries(result.agents.map(agent => [agent.id, {
  detected: agent.detected,
  typed: agent.typed,
  ownerPrompts: result.ownerPrompts.filter(prompt => prompt.agent === agent.id).length,
  agentWritten: result.agentWritten.filter(prompt => prompt.agent === agent.id).length,
}]));
// A CLI's answer goes to stdout (not the worker logger: this never runs inside the worker).
process.stdout.write(`${JSON.stringify({
  since: new Date(sinceEpochMs).toISOString(),
  durationMs: Date.now() - startedAt,
  ownerPrompts: result.ownerPrompts.length,
  agentWritten: result.agentWritten.length,
  agents: byAgent,
  skippedSources: result.skippedSources,
}, null, 2)}\n`);
