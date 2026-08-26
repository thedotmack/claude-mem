import { existsSync } from 'fs';
import { basename, resolve } from 'path';
import { styleText } from 'node:util';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import type { EatReport } from './types.js';

const USAGE = 'Usage: claude-mem eat <file|url|-|text> [--project <name>] [--dry-run] [--json] [--recursive]';
const MAX_LABEL_CHARS = 64;

export interface EatCliArgs {
  positional: string | undefined;
  project: string | null;
  dryRun: boolean;
  json: boolean;
  recursive: boolean;
}

function getArgValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

export function parseEatArgs(args: string[]): EatCliArgs {
  const positional = args.find(
    (arg, index) => (arg === '-' || !arg.startsWith('-')) && args[index - 1] !== '--project'
  );
  return {
    positional,
    project: getArgValue(args, '--project'),
    dryRun: args.includes('--dry-run'),
    json: args.includes('--json'),
    recursive: args.includes('--recursive'),
  };
}

async function readStdin(): Promise<string> {
  const buffers: Buffer[] = [];
  for await (const chunk of process.stdin) {
    buffers.push(chunk as Buffer);
  }
  return Buffer.concat(buffers).toString('utf-8');
}

function sourceLabel(report: EatReport): string {
  const label = report.source.kind === 'file' ? basename(report.source.locator) : report.source.locator;
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

export async function runEatCommand(args: string[]): Promise<number> {
  const parsed = parseEatArgs(args);
  const hasStdin = !process.stdin.isTTY;

  if (parsed.positional === undefined && !hasStdin) {
    console.error(USAGE);
    return 1;
  }

  const wantsStdin = parsed.positional === '-' || (parsed.positional === undefined && hasStdin);
  const project = parsed.project ?? basename(process.cwd());

  const body: Record<string, unknown> = { project };
  if (parsed.dryRun) body.dry_run = true;
  if (parsed.recursive) body.recursive = true;
  if (wantsStdin) {
    body.content = await readStdin();
  } else if (existsSync(parsed.positional as string)) {
    // Local paths resolve client-side to absolute so the worker (same
    // machine, different cwd) reads them server-side via `input`.
    body.input = resolve(parsed.positional as string);
  } else {
    body.input = parsed.positional;
  }

  const workerHost = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_HOST');
  const workerPort = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');
  const eatUrl = `http://${workerHost}:${workerPort}/api/eat`;

  const response = await fetch(eatUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? (error as Error & { cause?: { code?: string } }).cause : undefined;
    if (cause?.code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
      console.error(styleText('red', 'Worker is not running.'));
      console.error(`Start it with: ${styleText('bold', 'npx claude-mem start')}`);
      process.exit(1);
    }
    console.error(styleText('red', `EAT failed: ${message}`));
    process.exit(1);
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error(styleText('red', `EAT failed: HTTP ${response.status} ${detail}`));
    return 1;
  }

  const report = await response.json() as EatReport;

  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  const observations = report.drafts ? report.drafts.length : report.observation_ids.length;
  const suffix = parsed.dryRun ? ' [dry-run]' : '';
  console.log(
    `🍽  EAT digested ${report.chunks} chunk${report.chunks === 1 ? '' : 's'} from ${sourceLabel(report)} → ${observations} observation${observations === 1 ? '' : 's'} (${report.rejected} rejected)${suffix}`
  );
  return 0;
}
