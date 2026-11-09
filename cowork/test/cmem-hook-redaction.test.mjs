import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The shim is Cowork's only capture path, and it redacts locally before the
// envelope exists, so neither the ingest POST nor the retry spool ever holds a
// raw credential. Its pattern set is a mirror of the worker's
// src/utils/redaction.ts; these cases pin the shapes the mirror was missing, so
// a key that the local worker redacts cannot reach cmem.ai verbatim instead.
const hook = fileURLToPath(new URL('../scripts/cmem-hook.mjs', import.meta.url));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

function runHook(event, input, env) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [hook, event], { env, timeout: 20000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(stdout);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

const rep = (char, n) => char.repeat(n);

// Each case is a vendor shape no other shim pattern claims: the value is not
// named api_key=/token:, so KEYVALUE_RE cannot catch it, and no prefix in
// SECRET_PATTERNS matched it before this fix.
const shapes = [
  ['huggingface token', 'hf_' + rep('A', 34)],
  ['docker hub PAT', 'dckr_pat_' + rep('A', 27)],
  ['linear API key', 'lin_api_' + rep('A', 40)],
  ['notion integration token', 'ntn_' + rep('A', 46)],
  ['sendgrid API key', 'SG.' + rep('A', 22) + '.' + rep('B', 43)],
  ['digitalocean token', 'dop_v1_' + rep('a', 64)],
  ['shopify admin token', 'shpat_' + rep('a', 32)],
  ['pypi API token', 'pypi-AgE' + rep('A', 50)],
  ['databricks PAT', 'dapi' + rep('a', 32)],
  ['vault service token', 'hvs.' + rep('A', 90)],
  ['supabase access token', 'sbp_' + rep('a', 40)],
  ['sentry auth token', 'sntryu_' + rep('a', 64)],
  ['google oauth access token', 'ya29.' + rep('A', 30)],
  ['gitlab deploy token', 'gldt-' + rep('A', 20)],
  ['claude-mem server key', 'cmem_' + rep('A', 32)],
  ['slack refresh token', 'xoxe-1-' + rep('A', 20)],
  ['slack app-level token', 'xapp-1-' + rep('A', 20)],
  ['stripe webhook signing secret', 'whsec_' + rep('A', 32)],
];

test('cmem-hook redacts every vendor key shape the worker redacts', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cowork-redaction-'));
  const sent = [];
  let slug = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url.startsWith('/api/hooks/ingest')) sent.push(body);
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":1}');
    });
  });
  const port = await listen(server);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CLAUDE_MEM_DATA_DIR: join(home, '.claude-mem'),
    CMEM_API_BASE: `http://127.0.0.1:${port}`,
    CMEM_API_KEY: 'test-key-1234',
    CMEM_USER_ID: 'test-user',
    CMEM_SYNC_HUB_URL: '',
    CLAUDE_MEM_WORKER_PORT: '1',
    CLAUDE_CODE_CCR_SURFACE: '',
    CLAUDE_CODE_REMOTE: '',
  };

  try {
    for (const [name, value] of shapes) {
      await t.test(`${name} is redacted`, async () => {
        sent.length = 0;
        const id = `tu_redact_${slug++}`;
        await runHook('observation', {
          session_id: 's-redaction',
          cwd: '/home/claude',
          tool_name: 'Bash',
          tool_use_id: id,
          tool_input: { command: 'printenv | grep -i token' },
          tool_response: `key on record: ${value}`,
        }, env);
        const body = sent.join('\n');
        assert.ok(body.includes(id), `expected an ingest for ${id}; got: ${body}`);
        assert.ok(!body.includes(value), `${name} reached the ingest verbatim`);
        assert.ok(body.includes('[cmem-redacted]'), `${name} left no redaction marker`);
      });
    }

    // A structured tool_response is JSON-stringified before redaction, so a
    // secret at the start of a line arrives as `\n<SECRET>`. The `n` is a word
    // character, so a bare `\b` start cannot match there.
    await t.test('an auth-scheme credential after a structured newline is redacted', async () => {
      sent.length = 0;
      const opaque = rep('A', 24);
      await runHook('observation', {
        session_id: 's-redaction',
        cwd: '/home/claude',
        tool_name: 'Bash',
        tool_use_id: 'tu_redact_newline',
        tool_input: { command: 'cat .env' },
        tool_response: { stdout: 'ready\nBearer ' + opaque },
      }, env);
      const body = sent.join('\n');
      assert.ok(!body.includes(opaque), `a Bearer credential after a newline reached the ingest verbatim`);
      assert.ok(body.includes('[cmem-redacted]'));
    });

    await t.test('incoming webhook URLs keep their host and lose only the secret', async () => {
      sent.length = 0;
      const slack = rep('A', 24);
      const discord = rep('B', 60);
      await runHook('observation', {
        session_id: 's-redaction',
        cwd: '/home/claude',
        tool_name: 'Bash',
        tool_use_id: 'tu_redact_webhooks',
        tool_input: { command: 'cat .env' },
        tool_response: `SLACK=https://hooks.slack.com/services/T0000000/B0000000/${slack}\nDISCORD=https://discord.com/api/webhooks/12345678901234567/${discord}`,
      }, env);
      const body = sent.join('\n');
      assert.ok(!body.includes(slack), 'a Slack webhook secret reached the ingest verbatim');
      assert.ok(!body.includes(discord), 'a Discord webhook secret reached the ingest verbatim');
      assert.ok(body.includes('hooks.slack.com/services/T0000000/B0000000/'), 'the Slack host and channel ids must stay readable');
      assert.ok(body.includes('discord.com/api/webhooks/12345678901234567/'), 'the Discord host and channel id must stay readable');
    });

    // Host names ignore letter case, so a mixed-case host is the same URL and
    // has to be redacted the same way.
    await t.test('mixed-case webhook hosts are redacted too', async () => {
      sent.length = 0;
      const slack = rep('C', 24);
      const discord = rep('D', 60);
      await runHook('observation', {
        session_id: 's-redaction',
        cwd: '/home/claude',
        tool_name: 'Bash',
        tool_use_id: 'tu_redact_webhooks_case',
        tool_input: { command: 'cat .env' },
        tool_response: `SLACK=https://Hooks.Slack.Com/services/T0000000/B0000000/${slack}\nDISCORD=https://Discord.Com/api/v10/webhooks/12345678901234567/${discord}`,
      }, env);
      const body = sent.join('\n');
      assert.ok(!body.includes(slack), 'a mixed-case Slack host let its secret through');
      assert.ok(!body.includes(discord), 'a mixed-case Discord host let its secret through');
    });

    // The host is case-insensitive, the path is not: only the real path shapes
    // are webhook URLs, so an upper-case path is left alone.
    await t.test('webhook path segments stay case-sensitive', async () => {
      sent.length = 0;
      const notASecret = rep('E', 24);
      await runHook('observation', {
        session_id: 's-redaction',
        cwd: '/home/claude',
        tool_name: 'Bash',
        tool_use_id: 'tu_redact_webhooks_path',
        tool_input: { command: 'cat notes.txt' },
        tool_response: `https://hooks.slack.com/SERVICES/T0000000/B0000000/${notASecret}`,
      }, env);
      const body = sent.join('\n');
      assert.ok(body.includes(notASecret), 'an upper-case path is not a Slack webhook path');
    });

    // Negative control: a path that merely contains a webhook host is not a URL.
    await t.test('a webhook host inside a path is left alone', async () => {
      sent.length = 0;
      await runHook('observation', {
        session_id: 's-redaction',
        cwd: '/home/claude',
        tool_name: 'Bash',
        tool_use_id: 'tu_redact_control',
        tool_input: { command: 'grep hooks.slack.com' },
        tool_response: 'src/hooks.slack.com/services/T0000000/B0000000/notasecretpathvalue1234',
      }, env);
      const body = sent.join('\n');
      assert.ok(body.includes('notasecretpath'), 'a path segment must not be treated as a webhook secret');
    });
  } finally {
    await close(server);
    rmSync(home, { recursive: true, force: true });
  }
});
