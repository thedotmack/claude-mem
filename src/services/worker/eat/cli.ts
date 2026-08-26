import { existsSync } from 'fs';
import { basename, resolve } from 'path';
import { styleText } from 'node:util';
import { buildWorkerUrl } from '../../../shared/worker-utils.js';
import type { EatReport } from './types.js';

const USAGE = [
  'Usage: claude-mem eat <file|url|-|text> [--project <name>] [--dry-run] [--json] [--recursive]',
  "       claude-mem eat mcp <url> [--resource <uri>] [--header 'K: V']... [--project <name>] [--dry-run] [--json]",
].join('\n');
const MAX_LABEL_CHARS = 64;
const VALUE_FLAGS = new Set(['--project', '--resource', '--header']);

export interface EatMcpCliArgs {
  url: string | undefined;
  resource: string | null;
  headers: Record<string, string>;
}

export interface EatCliArgs {
  positional: string | undefined;
  project: string | null;
  dryRun: boolean;
  json: boolean;
  recursive: boolean;
  mcp?: EatMcpCliArgs;
}

function getArgValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function collectHeaders(args: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  args.forEach((arg, index) => {
    if (arg !== '--header') return;
    const raw = args[index + 1];
    if (raw === undefined) return;
    const separator = raw.indexOf(':');
    if (separator === -1) return;
    headers[raw.slice(0, separator).trim()] = raw.slice(separator + 1).trim();
  });
  return headers;
}

export function parseEatArgs(args: string[]): EatCliArgs {
  const isMcp = args[0] === 'mcp';
  const rest = isMcp ? args.slice(1) : args;
  const positional = rest.find(
    (arg, index) => (arg === '-' || !arg.startsWith('-')) && !VALUE_FLAGS.has(rest[index - 1] ?? '')
  );
  return {
    positional,
    project: getArgValue(rest, '--project'),
    dryRun: rest.includes('--dry-run'),
    json: rest.includes('--json'),
    recursive: rest.includes('--recursive'),
    mcp: isMcp
      ? { url: positional, resource: getArgValue(rest, '--resource'), headers: collectHeaders(rest) }
      : undefined,
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

  if (parsed.mcp !== undefined && parsed.mcp.url === undefined) {
    console.error(USAGE);
    return 1;
  }

  if (parsed.mcp === undefined && parsed.positional === undefined && !hasStdin) {
    console.error(USAGE);
    return 1;
  }

  const wantsStdin = parsed.mcp === undefined
    && (parsed.positional === '-' || (parsed.positional === undefined && hasStdin));
  const project = parsed.project ?? basename(process.cwd());

  const body: Record<string, unknown> = { project };
  if (parsed.dryRun) body.dry_run = true;
  if (parsed.recursive) body.recursive = true;
  if (parsed.mcp !== undefined) {
    const mcp: Record<string, unknown> = { url: parsed.mcp.url };
    if (parsed.mcp.resource !== null) mcp.resource = parsed.mcp.resource;
    if (Object.keys(parsed.mcp.headers).length > 0) mcp.headers = parsed.mcp.headers;
    body.mcp = mcp;
  } else if (wantsStdin) {
    body.content = await readStdin();
  } else if (existsSync(parsed.positional as string)) {
    // Local paths resolve client-side to absolute so the worker (same
    // machine, different cwd) reads them server-side via `input`.
    body.input = resolve(parsed.positional as string);
  } else {
    body.input = parsed.positional;
  }

  // buildWorkerUrl resolves host/port from the user's settings file (with env
  // overrides) — SettingsDefaultsManager.get alone would ignore settings.json.
  const eatUrl = buildWorkerUrl('/api/eat');

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
    const raw = await response.text();
    let parsed: { error?: string; detail?: string; request_id?: string } | null = null;
    try {
      parsed = JSON.parse(raw) as { error?: string; detail?: string; request_id?: string };
    } catch {
      // Non-JSON error body — fall through to the raw-text message below.
    }
    if (parsed?.error === undefined) {
      console.error(styleText('red', `EAT failed: HTTP ${response.status} ${raw}`));
      return 1;
    }
    const detailPart = parsed.detail ? ` — ${parsed.detail}` : '';
    const requestIdPart = parsed.request_id ? ` (request_id: ${parsed.request_id})` : '';
    console.error(styleText('red', `EAT failed: ${parsed.error}${detailPart}${requestIdPart}`));
    if (parsed.error === 'digest_failed' && /credential/i.test(parsed.detail ?? '')) {
      console.error(
        `Configure a model key: set the ${styleText('bold', 'CLAUDE_MEM_OPENROUTER_API_KEY')} credential (~/.claude-mem/.env or settings) or the ${styleText('bold', 'AI_GATEWAY_API_KEY')} env var.`
      );
    }
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
