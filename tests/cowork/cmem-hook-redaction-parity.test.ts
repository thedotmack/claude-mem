// The Cowork shim (cowork/scripts/cmem-hook.mjs) is Cowork's only capture path
// to cmem.ai, and it keeps its own copy of the worker's secret table because it
// has to stay dependency-free. Each time the worker learned a new key shape the
// copy fell behind, and keys the local worker redacts reached cmem.ai and the
// retry spool verbatim (#5483, #5543). This test holds one sample per worker
// built-in pattern: every sample must be redacted by the worker AND by the real
// shim, and a new worker pattern fails here until it gets a sample, so it
// cannot ship without the shim learning it too.
// HOME is a project-local .scratch directory, never the system temp directory.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_REDACTION_PATTERNS, redactSensitive, type RedactionConfig } from '../../src/utils/redaction.js';

const ROOT = join(import.meta.dir, '../..');
const HOOK = join(ROOT, 'cowork/scripts/cmem-hook.mjs');
const SCRATCH = join(ROOT, '.scratch');

const rep = (char: string, count: number) => char.repeat(count);

// `text` is what a tool prints; `secret` is the part that must not leave the
// machine (the whole text when omitted).
interface Sample { text: string; secret?: string }

const SAMPLES: Record<string, Sample[]> = {
  cookie_header: [
    { text: 'Cookie: sessionid=abc123def456ghi789', secret: 'abc123def456ghi789' },
    { text: 'set-cookie: sid=Zx9Yw8Vu7Ts6Rq5Po4Nn3Mm2', secret: 'Zx9Yw8Vu7Ts6Rq5Po4Nn3Mm2' },
  ],
  url_credentials: [{ text: 'postgres://app:hunter2parity@db.internal/prod', secret: 'hunter2parity' }],
  aws_access_key: [{ text: 'AKIA' + rep('Q', 16) }],
  aws_secret_key: [{ text: 'AWS_SECRET_ACCESS_KEY=' + rep('w', 40), secret: rep('w', 40) }],
  aws_session_token: [{ text: 'AWS_SESSION_TOKEN=' + rep('t', 120), secret: rep('t', 120) }],
  github_pat: [{ text: 'ghp_' + rep('G', 36) }],
  openai_key: [{ text: 'sk-proj' + rep('O', 30) }],
  anthropic_key: [{ text: 'sk-ant-api03-' + rep('N', 30) }],
  slack_token: [{ text: 'xoxb-' + rep('1', 12) + '-' + rep('s', 12) }, { text: 'xoxe-1-' + rep('E', 20) }, { text: 'xapp-1-' + rep('P', 20) }],
  jwt: [{ text: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + rep('j', 20) }],
  private_key_pem: [
    { text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEparityRsaBody\n-----END RSA PRIVATE KEY-----', secret: 'MIIEparityRsaBody' },
    { text: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYparityPgpBody\n-----END PGP PRIVATE KEY BLOCK-----', secret: 'lQOYparityPgpBody' },
  ],
  stripe_key: [{ text: 'sk_live_' + rep('S', 24) }, { text: 'whsec_' + rep('W', 32) }],
  google_api_key: [{ text: 'AIza' + rep('g', 35) }],
  google_oauth_token: [{ text: 'ya29.' + rep('y', 30) }],
  gitlab_token: [{ text: 'glpat-' + rep('L', 20) }, { text: 'gldt-' + rep('D', 20) }],
  huggingface_token: [{ text: 'hf_' + rep('H', 34) }],
  npm_token: [{ text: 'npm_' + rep('n', 36) }],
  docker_pat: [{ text: 'dckr_pat_' + rep('k', 27) }],
  linear_key: [{ text: 'lin_api_' + rep('l', 40) }],
  notion_token: [{ text: 'ntn_' + rep('T', 46) }],
  sendgrid_key: [{ text: 'SG.' + rep('x', 22) + '.' + rep('z', 43) }],
  digitalocean_token: [{ text: 'dop_v1_' + rep('d', 64) }],
  shopify_token: [{ text: 'shpat_' + rep('f', 32) }],
  pypi_token: [{ text: 'pypi-AgE' + rep('p', 50) }],
  databricks_token: [{ text: 'dapi' + rep('b', 32) }],
  vault_token: [{ text: 'hvs.' + rep('V', 90) }],
  nvidia_nim_key: [{ text: 'nvapi-' + rep('v', 32) }],
  runcrate_key: [{ text: 'rc_live_' + rep('r', 24) }],
  groq_key: [{ text: 'gsk_' + rep('q', 52) }],
  xai_key: [{ text: 'xai-' + rep('X', 80) }],
  perplexity_key: [{ text: 'pplx-' + rep('P', 48) }],
  supabase_token: [{ text: 'sbp_' + rep('e', 40) }],
  sentry_token: [{ text: 'sntryu_' + rep('c', 64) }],
  grafana_token: [{ text: 'glsa_' + rep('G', 32) + '_' + rep('a', 8) }, { text: 'glc_' + rep('Q', 40) + '==' }],
  postman_key: [{ text: 'PMAK-' + rep('b', 24) + '-' + rep('c', 34) }],
  slack_webhook: [{ text: 'https://hooks.slack.com/services/T0000000/B0000000/' + rep('K', 24), secret: rep('K', 24) }],
  discord_webhook: [{ text: 'https://discord.com/api/webhooks/12345678901234567/' + rep('C', 60), secret: rep('C', 60) }],
  claude_mem_key: [{ text: 'cmem_' + rep('M', 32) }, { text: 'cm_pro_' + rep('m', 16) }],
};

const WORKER_CONFIG: RedactionConfig = { enabled: true, disabledBuiltinPatterns: [], customPatterns: [], logMatches: false, genericEnabled: false };

let ingested: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let home: string;

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.text();
      if (new URL(request.url).pathname === '/api/hooks/ingest') ingested.push(body);
      return Response.json({ accepted: 1 }, { status: 202 });
    },
  });
  mkdirSync(SCRATCH, { recursive: true });
  home = mkdtempSync(join(SCRATCH, 'cowork-redaction-parity-'));
});
afterAll(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

let toolUseCounter = 0;
function runShim(toolResponse: string): Promise<string> {
  const toolUseId = `tu_parity_${toolUseCounter++}`;
  ingested = [];
  return new Promise((resolve, reject) => {
    const child = execFile('node', [HOOK, 'observation'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CLAUDE_MEM_DATA_DIR: join(home, '.claude-mem'),
        CMEM_API_BASE: `http://127.0.0.1:${server.port}`,
        CMEM_API_KEY: 'test-key-1234',
        CMEM_USER_ID: 'test-user',
        CMEM_SYNC_HUB_URL: '',
        CLAUDE_MEM_WORKER_PORT: '1',
      },
      timeout: 20_000,
    }, (error, _stdout, stderr) => {
      if (error) { reject(Object.assign(error, { stderr })); return; }
      const body = ingested.join('\n');
      if (!body.includes(toolUseId)) { reject(new Error(`no ingest for ${toolUseId}; stderr: ${stderr}`)); return; }
      resolve(body);
    });
    child.stdin!.end(JSON.stringify({
      session_id: 's-parity',
      cwd: '/home/claude',
      tool_name: 'Bash',
      tool_use_id: toolUseId,
      tool_input: { command: 'cat .env' },
      tool_response: `printed: ${toolResponse}`,
    }));
  });
}

describe('Cowork shim redacts every key shape the worker redacts', () => {
  it('has a sample for every worker built-in pattern', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(BUILTIN_REDACTION_PATTERNS.map((pattern) => pattern.name).sort());
  });

  for (const [name, samples] of Object.entries(SAMPLES)) {
    samples.forEach((sample, index) => {
      const secret = sample.secret ?? sample.text;
      it(`${name} sample ${index + 1}: the worker redacts it`, () => {
        const result = redactSensitive(`printed: ${sample.text}`, WORKER_CONFIG);
        expect(result.counts[name] ?? 0).toBeGreaterThan(0);
        expect(result.redacted).not.toContain(secret);
      });
    });
  }

  it('the Cowork shim redacts every sample in one response', async () => {
    const samples = Object.entries(SAMPLES).flatMap(([name, values]) =>
      values.map((sample, index) => ({ name: `${name} sample ${index + 1}`, ...sample })));
    const body = await runShim(samples.map(sample => sample.text).join('\n'));
    expect(samples.filter(sample => body.includes(sample.secret ?? sample.text)).map(sample => sample.name)).toEqual([]);
    expect(body).toContain('[cmem-redacted]');
  });
});
