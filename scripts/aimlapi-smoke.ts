// One-shot check that the aimlapi.com provider is wired end to end.
//
//   bun scripts/aimlapi-smoke.ts
//
// Reads the real ~/.claude-mem/settings.json, resolves the endpoint and builds
// the headers through the SAME modules the worker uses — not a re-implementation
// — then makes one chat-completions call and reports what came back.
//
// Point CLAUDE_MEM_AIMLAPI_BASE_URL at the header probe first if you want to
// watch the request leave: node aimlapi-header-probe.mjs 8788

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { aimlapiAttributionHeaders } from '../src/shared/aimlapi-attribution.js';
import { resolveAimlapiChatCompletionsUrl } from '../src/shared/aimlapi-base-url.js';

const settingsPath = join(homedir(), '.claude-mem', 'settings.json');

let settings: Record<string, unknown> = {};
try {
  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
} catch (err) {
  console.error(`could not read ${settingsPath}: ${(err as Error).message}`);
  process.exit(1);
}

const str = (k: string): string => {
  const v = settings[k];
  return typeof v === 'string' ? v.trim() : '';
};

const provider = str('CLAUDE_MEM_PROVIDER');
const apiKey = str('CLAUDE_MEM_AIMLAPI_API_KEY') || (process.env.AIMLAPI_API_KEY ?? '').trim();
const model = str('CLAUDE_MEM_AIMLAPI_MODEL') || 'openai/gpt-5.6-terra-pro';
const url = resolveAimlapiChatCompletionsUrl(str('CLAUDE_MEM_AIMLAPI_BASE_URL'));
const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${apiKey}`,
  ...aimlapiAttributionHeaders(str('CLAUDE_MEM_AIMLAPI_SITE_URL'), str('CLAUDE_MEM_AIMLAPI_APP_NAME')),
};

console.log('settings file :', settingsPath);
console.log('provider      :', provider || '(unset)', provider === 'aimlapi' ? '' : '  <- not aimlapi; the worker will not use this provider');
console.log('endpoint      :', url);
console.log('model         :', model);
console.log('api key       :', apiKey ? `set (…${apiKey.slice(-4)})` : 'MISSING');
console.log('headers sent  :');
for (const [k, v] of Object.entries(headers)) {
  console.log(`   ${k}: ${k === 'Authorization' ? 'Bearer …' + apiKey.slice(-4) : v}`);
}

if (!apiKey) {
  console.error('\nno API key — set CLAUDE_MEM_AIMLAPI_API_KEY in settings.json');
  process.exit(1);
}

console.log('\ncalling…');
const res = await fetch(url, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    max_tokens: 16,
  }),
});

const text = await res.text();
console.log(`status: ${res.status}`);

if (res.ok) {
  try {
    const data = JSON.parse(text);
    console.log('reply :', data.choices?.[0]?.message?.content ?? '(no content)');
    console.log('usage :', JSON.stringify(data.usage ?? {}));
    console.log('\nOK — the provider reached aimlapi.com and the call was accepted.');
  } catch {
    console.log(text.slice(0, 400));
  }
} else {
  console.log(text.slice(0, 600));
  if (res.status === 401) console.log('\n401 = the key was rejected. Check it at https://aimlapi.com/app/keys');
  if (res.status === 403) console.log('\n403 = key is valid but the balance is empty. Top up at https://aimlapi.com/app/billing/');
  process.exit(1);
}
