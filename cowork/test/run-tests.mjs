#!/usr/bin/env node
// Test harness for claude-mem-cowork hooks. Mock cmem.ai server + assertions.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, rmSync, readFileSync, statSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { fileURLToPath } from 'node:url';
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const HOOK = PLUGIN_DIR + '/scripts/cmem-hook.mjs';
// hermetic HOME so the suite never touches the real ~/.claude-mem
const TESTHOME = '/tmp/cmem-testhome';
const SPOOL = TESTHOME + '/.claude-mem/cowork-spool.jsonl';
let received = [];
let mode = 'full'; // 'full' | 'no-hooks-endpoints' (404s, mcp only)

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const rec = { method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
    received.push(rec);
    if (req.url.startsWith('/api/hooks/ingest')) {
      if (mode === 'no-hooks-endpoints') { res.writeHead(404); return res.end('{}'); }
      res.writeHead(202, { 'content-type': 'application/json' });
      return res.end('{"accepted":1}');
    }
    if (req.url.startsWith('/api/hooks/context')) {
      if (mode === 'no-hooks-endpoints') { res.writeHead(404); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ context: '- [obs] Shipped Pro trial funnel v13.15.0\n- [obs] Parity gate 14 fail / 1 pass' }));
    }
    if (req.url.startsWith('/api/mcp')) {
      const rpc = rec.body;
      if (rpc?.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        const rowsJson = JSON.stringify({ freshness: 'now', rows: [
          { kind: 'observation', project: 'cmem_work_root', title: 'Root obs A', snippet: 'root detail' },
          { kind: 'observation', project: 'claude-mem/other', title: 'Other obs', snippet: 'nope' }
        ]});
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: rowsJson }] } }));
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc?.id ?? null, result: {} }));
    }
    res.writeHead(404); res.end();
  });
});

function run(event, stdinObj, env = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('node', [HOOK, event], {
      env: { ...process.env, HOME: TESTHOME, CMEM_API_BASE: `http://127.0.0.1:${PORT}`, CMEM_API_KEY: 'test-key-1234', ...env },
      encoding: 'utf8', timeout: 45000
    }, (err, stdout) => err && err.code !== 0 && err.killed ? reject(err) : resolve({ out: stdout, code: err?.code || 0 }));
    child.stdin.end(typeof stdinObj === 'string' ? stdinObj : stdinObj ? JSON.stringify(stdinObj) : '');
  });
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

const PORT = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
rmSync(TESTHOME, { recursive: true, force: true });

// ---- 1. observation capture ----
console.log('\n[1] PostToolUse observation');
received = [];
await run('observation', { session_id: 's1', cwd: '/home/claude', tool_name: 'Write', tool_use_id: 'tu_1', tool_input: { file_path: '/x.md', content: 'hello' }, tool_response: 'ok' });
const ing = received.find(r => r.url.startsWith('/api/hooks/ingest'));
check('POSTs to /api/hooks/ingest', !!ing);
check('bearer auth sent', ing?.auth === 'Bearer test-key-1234');
check('envelope shape', ing?.body.v === 1 && ing.body.event === 'observation' && ing.body.platform === 'cowork' && ing.body.session_id === 's1');
check('fragment fields', ing?.body.payload.tool_name === 'Write' && ing.body.payload.tool_use_id === 'tu_1');

// ---- 2. big field truncation ----
console.log('\n[2] truncation');
received = [];
await run('observation', { session_id: 's1', tool_name: 'Read', tool_use_id: 'tu_2', tool_input: {}, tool_response: 'x'.repeat(100000) });
const ing2 = received.find(r => r.url.startsWith('/api/hooks/ingest'));
check('response truncated to ~16KB', typeof ing2?.body.payload.tool_response === 'string' && ing2.body.payload.tool_response.length < 17000 && ing2.body.payload.tool_response.includes('truncated'));

// ---- 2b. secret redaction ----
console.log('\n[2b] secret redaction');
received = [];
await run('observation', {
  session_id: 's1', cwd: '/home/claude', tool_name: 'Bash', tool_use_id: 'tu_2b',
  tool_input: { command: 'curl -H "Authorization: Bearer sk-ant-api03-Zx9AbCdEfGh12345678" https://api.example.com' },
  tool_response: 'export API_KEY=abc123secretvalue\nghp_AbCdEfGhIjKlMnOpQrStUvWxYz123456\npassword: hunter2secret'
});
const ing2b = received.find(r => r.url.startsWith('/api/hooks/ingest'));
const sentIn = String(ing2b?.body.payload.tool_input || '');
const sentOut = String(ing2b?.body.payload.tool_response || '');
check('sk-ant key redacted from tool_input', !sentIn.includes('sk-ant-api03') && sentIn.includes('[cmem-redacted]'), sentIn);
check('github token redacted from tool_response', !sentOut.includes('ghp_AbCdEf'), sentOut);
check('key=value secrets redacted', !sentOut.includes('abc123secretvalue') && !sentOut.includes('hunter2secret'), sentOut);
check('non-secret signal kept', sentIn.includes('https://api.example.com') && sentOut.includes('API_KEY='), sentIn + ' | ' + sentOut);
received = [];
await run('observation', {
  session_id: 's1', cwd: '/home/claude', tool_name: 'Bash', tool_use_id: 'tu_2d',
  tool_input: { command: 'export DATABASE_URL=postgresql://admin:longpassword@db.internal/app' },
  tool_response: 'cloned from ssh://git@github.com/x/y and redis://user2:s3cr3tpw@cache:6379/0'
});
const ing2d = received.find(r => r.body?.payload?.tool_use_id === 'tu_2d');
const in2d = String(ing2d?.body.payload.tool_input || '');
const out2d = String(ing2d?.body.payload.tool_response || '');
check('connection-string password redacted', !in2d.includes('longpassword') && in2d.includes('postgresql://') && in2d.includes('db.internal'), in2d);
check('redis URI credentials redacted', !out2d.includes('s3cr3tpw'), out2d);
check('bare user@ URIs untouched (git@github.com)', out2d.includes('ssh://git@github.com/x/y'), out2d);
received = [];
await run('observation', {
  session_id: 's1', cwd: '/home/claude', tool_name: 'Bash', tool_use_id: 'tu_2e',
  tool_input: { command: 'psql postgresql://admin:pa/ss@db.internal/app && psql postgresql://admin:pa@ss@db.internal/app' },
  tool_response: 'Cookie: sessionid=opaque-session-secret-value; theme=dark'
});
const ing2e = received.find(r => r.body?.payload?.tool_use_id === 'tu_2e');
const in2e = String(ing2e?.body.payload.tool_input || '');
const out2e = String(ing2e?.body.payload.tool_response || '');
check('slash-containing URI password fully redacted', !in2e.includes('pa/ss'), in2e);
check('at-sign-containing URI password fully redacted', !in2e.includes('pa@ss') && !in2e.includes(']@ss@'), in2e);
check('URI host survives userinfo redaction', in2e.includes('db.internal/app'), in2e);
check('Cookie header value redacted', !out2e.includes('opaque-session-secret-value'), out2e);
// Token-scheme Authorization: redacted in the request body AND in the spool on failed delivery
received = [];
await run('observation', {
  session_id: 's1', cwd: '/home/claude', tool_name: 'Bash', tool_use_id: 'tu_2f',
  tool_input: { command: 'curl -H "Authorization: Token tok-cred-9f8e7d6c5b4a"' }, tool_response: 'ok'
});
const in2f = String(received.find(r => r.body?.payload?.tool_use_id === 'tu_2f')?.body.payload.tool_input || '');
check('Token-scheme Authorization redacted in request', !in2f.includes('tok-cred-9f8e7d6c5b4a'), in2f);
rmSync(SPOOL, { force: true });
await run('observation', {
  session_id: 's1', cwd: '/home/claude', tool_name: 'Bash', tool_use_id: 'tu_2g',
  tool_input: { command: 'curl -H "Authorization: Token tok-cred-9f8e7d6c5b4a"' }, tool_response: 'ok'
}, { CMEM_API_BASE: 'http://127.0.0.1:1' });
check('Token-scheme Authorization redacted in spool', existsSync(SPOOL) && !readFileSync(SPOOL, 'utf8').includes('tok-cred-9f8e7d6c5b4a'), readFileSync(SPOOL, 'utf8').slice(0, 200));
rmSync(SPOOL, { force: true });

// ---- 2c. <private> tag stripping ----
console.log('\n[2c] private-tag stripping');
received = [];
await run('observation', {
  session_id: 's1', cwd: '/home/claude', tool_name: 'Bash', tool_use_id: 'tu_2c',
  tool_input: { command: 'echo before <private>SSN 123-45-6789</private> after' },
  tool_response: 'ok <private>\nmulti\nline secret\n</private> done'
});
await run('session-init', { session_id: 's1', prompt: 'plan the launch <private>budget is $40k</private> by friday' });
const ing2c = received.find(r => r.body?.payload?.tool_use_id === 'tu_2c');
const init2c = received.find(r => r.body?.event === 'session-init');
const in2c = String(ing2c?.body.payload.tool_input || '');
const out2c = String(ing2c?.body.payload.tool_response || '');
check('private region gone from tool_input', !in2c.includes('123-45-6789') && !in2c.includes('<private>'), in2c);
check('multi-line private region gone from tool_response', !out2c.includes('line secret') && out2c.includes('ok') && out2c.includes('done'), out2c);
check('private region gone from session-init prompt', init2c?.body.payload.prompt === 'plan the launch  by friday', init2c?.body.payload.prompt);
check('surrounding signal kept', in2c.includes('before') && in2c.includes('after'), in2c);

// ---- 3. memory-tool feedback guard ----
console.log('\n[3] skip guard');
received = [];
await run('observation', { session_id: 's1', tool_name: 'mcp__memory__memory_write', tool_use_id: 'tu_3' });
check('memory tool calls not captured', !received.some(r => r.url.startsWith('/api/hooks/ingest')));

// ---- 4. SessionStart context injection ----
console.log('\n[4] SessionStart inject');
received = [];
let out = (await run('context', { session_id: 's1', cwd: '/home/claude', source: 'startup' })).out;
let j = JSON.parse(out);
check('hookSpecificOutput.SessionStart', j.hookSpecificOutput?.hookEventName === 'SessionStart');
check('context block wrapped', j.hookSpecificOutput?.additionalContext.includes('<claude-mem-context') && j.hookSpecificOutput.additionalContext.includes('Parity gate'));
check('session-start also ingested', received.some(r => r.url.startsWith('/api/hooks/ingest') && r.body?.event === 'session-start' || (r.body?.batch || []).some?.(e => e.event === 'session-start')));

// ---- 5. agent-context updatedInput ----
console.log('\n[5] PreToolUse agent inject');
received = [];
out = (await run('agent-context', { session_id: 's1', tool_name: 'Agent', tool_input: { description: 'fix bug', prompt: 'Fix the trial funnel installer bug' } })).out;
j = JSON.parse(out);
check('updatedInput present', !!j.hookSpecificOutput?.updatedInput);
check('prompt prepended + original kept', j.hookSpecificOutput?.updatedInput.prompt.startsWith('<claude-mem-context') && j.hookSpecificOutput.updatedInput.prompt.endsWith('Fix the trial funnel installer bug'));
check('other input fields preserved', j.hookSpecificOutput?.updatedInput.description === 'fix bug');
out = (await run('agent-context', { session_id: 's1', tool_name: 'Agent', tool_input: { prompt: '<claude-mem-context>already</claude-mem-context> do it' } })).out;
check('no double-injection', out.trim() === '');

// ---- 6. MCP fallback when /api/hooks/* is 404 ----
console.log('\n[6] MCP fallback (endpoints not deployed)');
mode = 'no-hooks-endpoints';
received = [];
out = (await run('context', { session_id: 's1', cwd: '/home/claude', source: 'startup' })).out;
j = out.trim() ? JSON.parse(out) : null;
check('falls back to /api/mcp, scoped rows injected', j?.hookSpecificOutput?.additionalContext.includes('Root obs A'));
check('other-project rows filtered out', !j?.hookSpecificOutput?.additionalContext.includes('Other obs'));
check('404 ingest not spooled', !existsSync(SPOOL));
// 6b: project with zero observations -> taking-notes notice with viewer link
out = (await run('context', { session_id: 's1', cwd: '/home/claude/work/widget-app', source: 'startup' })).out;
j = out.trim() ? JSON.parse(out) : null;
check('empty project → taking-notes notice', j?.hookSpecificOutput?.additionalContext.includes('automatically taking notes') && j.hookSpecificOutput.additionalContext.includes('cmem_work_widget-app'));
check('notice has live viewer link', /http:\/\/localhost:\d+/.test(j?.hookSpecificOutput?.additionalContext || ''));
mode = 'full';

// ---- 7. no key → inert (blank-config plugin copy, isolated HOME) ----
console.log('\n[7] unpaired = inert');
const { execSync } = await import('node:child_process');
execSync(`rm -rf /tmp/plugin-blank /tmp/emptyhome && mkdir -p /tmp/emptyhome && cp -r ${PLUGIN_DIR} /tmp/plugin-blank`);
execSync(`node -e "const f='/tmp/plugin-blank/config.json',fs=require('fs'),c=JSON.parse(fs.readFileSync(f));c.apiKey='';c.userId='';c.syncHubUrl='';fs.writeFileSync(f,JSON.stringify(c))"`);
received = [];
out = (await new Promise((resolve) => {
  const child = (execFile)('node', ['/tmp/plugin-blank/scripts/cmem-hook.mjs', 'observation'], {
    env: { ...process.env, HOME: '/tmp/emptyhome', CMEM_API_BASE: `http://127.0.0.1:${PORT}`, CMEM_API_KEY: '' },
    encoding: 'utf8', timeout: 45000
  }, (err, stdout) => resolve({ out: stdout }));
  child.stdin.end(JSON.stringify({ session_id: 's1', tool_name: 'Write', tool_use_id: 'tu_9' }));
})).out;
check('no requests without key', received.length === 0);
check('no stdout', out.trim() === '');
// 7b: ~/.claude-mem/settings.json fallback supplies credentials when config is blank
received = [];
execSync('mkdir -p /tmp/emptyhome/.claude-mem');
execSync(`node -e "require('fs').writeFileSync('/tmp/emptyhome/.claude-mem/settings.json',JSON.stringify({CLAUDE_MEM_CLOUD_SYNC_TOKEN:'cm_test_fallback',CLAUDE_MEM_CLOUD_SYNC_USER_ID:'u-1',CLAUDE_MEM_WORKER_PORT:'37777'}))"`);
await new Promise((resolve) => {
  const child = (execFile)('node', ['/tmp/plugin-blank/scripts/cmem-hook.mjs', 'observation'], {
    env: { ...process.env, HOME: '/tmp/emptyhome', CMEM_API_BASE: `http://127.0.0.1:${PORT}`, CMEM_API_KEY: '' },
    encoding: 'utf8', timeout: 45000
  }, () => resolve());
  child.stdin.end(JSON.stringify({ session_id: 's1', tool_name: 'Write', tool_use_id: 'tu_9b' }));
});
const fb = received.find(r => r.url.startsWith('/api/hooks/ingest'));
check('~/.claude-mem/settings.json fallback used', fb?.auth === 'Bearer cm_test_fallback');

// ---- 8. server down → spool, then flush ----
console.log('\n[8] spool + flush');
rmSync(SPOOL, { force: true });
await run('observation', { session_id: 's2', tool_name: 'Bash', tool_use_id: 'tu_10', tool_input: { command: 'ls' } }, { CMEM_API_BASE: 'http://127.0.0.1:1' });
check('failed POST spooled', existsSync(SPOOL) && readFileSync(SPOOL, 'utf8').includes('tu_10'));
check('spool is user-only (0600)', existsSync(SPOOL) && (statSync(SPOOL).mode & 0o777) === 0o600, (statSync(SPOOL).mode & 0o777).toString(8));
check('spool lives under $HOME/.claude-mem (per-user, not shared /tmp)', SPOOL === TESTHOME + '/.claude-mem/cowork-spool.jsonl' && existsSync(TESTHOME + '/.claude-mem'));
received = [];
await run('observation', { session_id: 's2', tool_name: 'Bash', tool_use_id: 'tu_11', tool_input: { command: 'pwd' } });
const gotBatch = received.some(r => r.body?.batch?.some(e => e.payload?.tool_use_id === 'tu_10'));
check('spool flushed as batch on next event', gotBatch);
check('spool cleared', !existsSync(SPOOL) || readFileSync(SPOOL, 'utf8').trim() === '');

// ---- 8b. spool replay order ----
console.log('\n[8b] spool replay order');
rmSync(SPOOL, { force: true });
mkdirSync(TESTHOME + '/.claude-mem', { recursive: true });
// file order NEW-then-OLD (what a failed-flush merge race can produce)
appendFileSync(SPOOL, JSON.stringify({ v: 1, platform: 'cowork', event: 'observation', project: 'cmem_work_root', session_id: 's2', ts: 2000, payload: { tool_use_id: 'tu_newer' } }) + '\n');
appendFileSync(SPOOL, JSON.stringify({ v: 1, platform: 'cowork', event: 'observation', project: 'cmem_work_root', session_id: 's2', ts: 1000, payload: { tool_use_id: 'tu_older' } }) + '\n');
received = [];
await run('observation', { session_id: 's2', cwd: '/home/claude', tool_name: 'Bash', tool_use_id: 'tu_13', tool_input: { command: 'true' } });
const orderedBatch = received.find(r => r.body?.batch)?.body.batch.map(e => e.payload.tool_use_id);
check('flush replays oldest-first (ts sort)', JSON.stringify(orderedBatch) === JSON.stringify(['tu_older', 'tu_newer']), JSON.stringify(orderedBatch));

// ---- 8c. overflow spool never drops events ----
console.log('\n[8c] spool overflow (SPOOL_MAX=200)');
rmSync(SPOOL, { force: true });
for (let i = 1; i <= 201; i++) {
  appendFileSync(SPOOL, JSON.stringify({ v: 1, platform: 'cowork', event: 'observation', project: 'cmem_work_root', session_id: 's2', ts: 1000 + i, payload: { tool_use_id: 'e' + i } }) + '\n');
}
received = [];
await run('observation', { session_id: 's2', cwd: '/home/claude', tool_name: 'Bash', tool_use_id: 'tu_14', tool_input: { command: 'true' } });
const bigBatch = received.find(r => r.body?.batch)?.body.batch.map(e => e.payload.tool_use_id) || [];
check('first flush sends oldest 200', bigBatch.length === 200 && bigBatch[0] === 'e1' && bigBatch[199] === 'e200', `len=${bigBatch.length} first=${bigBatch[0]} last=${bigBatch[199]}`);
check('overflow remainder re-spooled, not dropped', existsSync(SPOOL) && readFileSync(SPOOL, 'utf8').includes('"e201"'));
received = [];
await run('observation', { session_id: 's2', cwd: '/home/claude', tool_name: 'Bash', tool_use_id: 'tu_15', tool_input: { command: 'true' } });
const tailBatch = received.find(r => r.body?.batch)?.body.batch.map(e => e.payload.tool_use_id) || [];
check('next flush delivers the remainder', tailBatch.includes('e201'), JSON.stringify(tailBatch));
check('spool empty after full drain', !existsSync(SPOOL) || readFileSync(SPOOL, 'utf8').trim() === '');

// ---- 9. remaining lifecycle events ----
console.log('\n[9] lifecycle events');
received = [];
await run('session-init', { session_id: 's1', prompt: 'hello world' });
await run('subagent-stop', { session_id: 's1', agent_id: 'a1', agent_type: 'general-purpose', tool_use_id: 'tu_12' });
await run('summarize', { session_id: 's1' });
await run('session-end', { session_id: 's1', reason: 'exit' });
const evs = received.filter(r => r.url.startsWith('/api/hooks/ingest')).map(r => r.body.event);
check('session-init/subagent-stop/summarize/session-end all sent', ['session-init', 'subagent-stop', 'summarize', 'session-end'].every(e => evs.includes(e)), JSON.stringify(evs));
const initEv = received.find(r => r.body?.event === 'session-init');
check('prompt included in session-init', initEv?.body.payload.prompt === 'hello world');

// ---- 9b. project auto-naming (cmem_work_ prefix) ----
console.log('\n[9b] project auto-naming');
received = [];
await run('observation', { session_id: 's3', cwd: '/home/claude', tool_name: 'Bash', tool_use_id: 'tu_20' });
await run('observation', { session_id: 's3', cwd: '/home/claude/work/Leads Dashboard!', tool_name: 'Bash', tool_use_id: 'tu_21' });
await run('observation', { session_id: 's3', cwd: '/tmp', tool_name: 'Bash', tool_use_id: 'tu_22' });
const projOf = id => received.find(r => r.body?.payload?.tool_use_id === id)?.body.project;
check('root cwd → cmem_work_root', projOf('tu_20') === 'cmem_work_root', projOf('tu_20'));
check('project folder → cmem_work_<slug>', projOf('tu_21') === 'cmem_work_leads-dashboard', projOf('tu_21'));
check('generic dir (/tmp) → cmem_work_root', projOf('tu_22') === 'cmem_work_root', projOf('tu_22'));
received = [];
await run('observation', { session_id: 's3', cwd: '/home/claude', tool_name: 'Bash', tool_use_id: 'tu_23' }, { CMEM_PROJECT: 'my-explicit' });
check('project is NOT a setting — env override ignored', received[0]?.body.project === 'cmem_work_root', received[0]?.body.project);

// ---- 10. malformed stdin never crashes ----
console.log('\n[10] resilience');
const r1 = await run('observation', '{{{not json');
check('malformed stdin exits 0', r1.code === 0);
const r2 = await run('unknown-event', '{}');
check('unknown event exits 0', r2.code === 0);

server.close();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
