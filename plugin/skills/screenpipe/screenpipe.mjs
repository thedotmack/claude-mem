import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HELP = `Screenpipe context for claude-mem (Node.js 20+)

search --start <ISO timestamp> --end <ISO timestamp>
       [--query <text>] [--app <name>] [--type ocr|audio|all]
       [--limit 1..50] [--offset <number>]
save   --file <reviewed note> --project <name> --worker-url <local URL>
       [--title <text>]

Search uses SCREENPIPE_URL (default http://127.0.0.1:3030) and optional
SCREENPIPE_API_KEY. Save writes the note to claude-mem's local worker.
No automatic import or background sync. Search output can be captured by
your agent's normal hooks and sent to its configured AI provider.`;

function localEndpoint(base, path) {
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use a local HTTP origin, such as http://127.0.0.1:3030.');
  }
  return new URL(path, url);
}

async function request(url, init, service) {
  try {
    const response = await fetch(url, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`${service} returned HTTP ${response.status}. ${response.status === 401 || response.status === 403
        ? 'Check the configured API credentials.' : 'Check the service status.'}`);
    }
    return await response.json();
  } catch (error) {
    if (error.message?.startsWith(`${service} returned HTTP`)) throw error;
    const cause = error.cause?.code || error.name;
    throw new Error(`${service} request failed (${cause}). Check that it is running at ${url.origin} and returning JSON.`);
  }
}

function integer(value, name, min, max) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return Number(value);
}

export async function run(args, env = process.env) {
  const [command, ...flags] = args;
  if (!command || command === '--help') return HELP;
  const options = command === 'search'
    ? ['start', 'end', 'query', 'app', 'type', 'limit', 'offset']
    : command === 'save' ? ['file', 'project', 'worker-url', 'title'] : null;
  if (!options) throw new Error('Expected search or save. Use --help for usage.');
  const { values } = parseArgs({ args: flags, options: Object.fromEntries(options.map(key => [key, { type: 'string' }])) });

  if (command === 'save') {
    if (!values.file || !values.project?.trim() || !values['worker-url']) {
      throw new Error('save requires --file, --project, and --worker-url.');
    }
    const url = localEndpoint(values['worker-url'], '/api/memory/save');
    const text = (await readFile(values.file, 'utf8')).trim();
    if (!text || Buffer.byteLength(text) > 64 * 1024) throw new Error('The reviewed note must contain 1..65536 bytes.');
    const saved = await request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, title: values.title, project: values.project.trim(), metadata: { source: 'screenpipe' } }),
    }, 'claude-mem');
    if (saved.success !== true || !Number.isSafeInteger(saved.id)) {
      throw new Error('claude-mem did not confirm a saved observation. Check the worker before retrying.');
    }
    return saved;
  }

  for (const key of ['start', 'end']) {
    if (!values[key] || !/(Z|[+-]\d{2}:\d{2})$/.test(values[key]) || !Number.isFinite(Date.parse(values[key]))) {
      throw new Error(`--${key} must be an ISO timestamp with a timezone.`);
    }
  }
  if (Date.parse(values.start) >= Date.parse(values.end)) throw new Error('--start must be before --end.');
  const type = values.type || 'ocr';
  if (!['ocr', 'audio', 'all'].includes(type)) throw new Error('--type must be ocr, audio, or all.');
  const limit = integer(values.limit || '20', '--limit', 1, 50);
  const offset = integer(values.offset || '0', '--offset', 0, Number.MAX_SAFE_INTEGER);
  const url = localEndpoint(env.SCREENPIPE_URL || 'http://127.0.0.1:3030', '/search');
  url.search = new URLSearchParams({
    start_time: new Date(values.start).toISOString(), end_time: new Date(values.end).toISOString(),
    content_type: type, limit: String(limit), offset: String(offset), include_frames: 'false',
    ...(values.query ? { q: values.query } : {}), ...(values.app ? { app_name: values.app } : {}),
  }).toString();
  const result = await request(url, {
    headers: env.SCREENPIPE_API_KEY ? { Authorization: `Bearer ${env.SCREENPIPE_API_KEY}` } : {},
  }, 'Screenpipe');
  if (!Array.isArray(result.data)) throw new Error('Screenpipe returned an unexpected search response (missing data array).');
  const records = [];
  for (const row of result.data.slice(0, limit)) {
    const content = row?.content;
    if (!['OCR', 'Audio', 'UI'].includes(row?.type) || !content) continue;
    const text = row.type === 'Audio' ? content.transcription : content.text;
    if (typeof text !== 'string' || !text.trim()) continue;
    records.push({
      source: 'screenpipe', type: row.type,
      id: content.frame_id ?? content.chunk_id ?? content.id,
      timestamp: content.timestamp, app: content.app_name, window: content.window_name,
      text: text.slice(0, 2000), truncated: text.length > 2000,
    });
  }
  const total = result.pagination?.total;
  return {
    records, returned: result.data.length, omitted: result.data.length - records.length,
    offset, total: Number.isSafeInteger(total) ? total : null,
    next_offset: result.data.length === limit && (!Number.isSafeInteger(total) || offset + limit < total) ? offset + limit : null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await run(process.argv.slice(2));
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Screenpipe integration: ${error.message}`);
    process.exitCode = 1;
  }
}
