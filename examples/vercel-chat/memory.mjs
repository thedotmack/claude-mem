import { createHash, timingSafeEqual } from 'node:crypto';
import { Chat } from 'chat';
import { createWebAdapter } from '@chat-adapter/web';
import { createMemoryState } from '@chat-adapter/state-memory';

// One local owner and one project. Client messages cannot select either identity.
const project = process.env.CHAT_MEMORY_PROJECT;
const token = process.env.CHAT_DEMO_TOKEN;
const worker = new URL(process.env.CLAUDE_MEM_WORKER_URL || 'http://127.0.0.1:37777');
if (!project?.trim() || !token || token.length < 24) {
  throw new Error('Set CHAT_MEMORY_PROJECT and a CHAT_DEMO_TOKEN of at least 24 characters');
}
if (worker.protocol !== 'http:' || worker.hostname !== '127.0.0.1' || worker.username || worker.password || worker.pathname !== '/' || worker.search || worker.hash) {
  throw new Error('CLAUDE_MEM_WORKER_URL must be a credential-free http://127.0.0.1:PORT origin');
}
const port = Number(process.env.CHAT_DEMO_PORT || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CHAT_DEMO_PORT');
const expected = Buffer.from(`Bearer ${token}`);
const state = createMemoryState();
const bot = new Chat({
  userName: 'memory',
  adapters: {
    web: createWebAdapter({
      userName: 'memory',
      persistMessageHistory: false,
      getUser(request) {
        const supplied = Buffer.from(request.headers.get('authorization') || '');
        return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? { id: 'owner' } : null;
      },
    }),
  },
  state,
});

async function request(path, body) {
  const response = await fetch(new URL(path, worker), {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Worker returned HTTP ${response.status}`);
  return response.json();
}

bot.onDirectMessage(async (thread, message) => {
  const [, command, argument = ''] = message.text.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) || [];
  let result;
  try {
    if (command === 'save' && argument) {
      // The worker's existing transactional receipt deduplication survives restarts.
      const fingerprint = createHash('sha256').update(JSON.stringify([thread.id, message.id, message.text])).digest('hex');
      result = await request('/api/memory/save', {
        project, cwd: process.cwd(), text: argument, metadata: { sourceFingerprint: `vercel-chat:${fingerprint}` },
      });
      if (result.success !== true) throw new Error('Worker did not confirm the save');
    } else if (command === 'search' && argument) {
      const query = new URLSearchParams({ query: argument, project, projects: JSON.stringify([project]), type: 'observations', format: 'json', limit: '10' });
      result = await request(`/api/search?${query}`);
    } else if (command === 'get' && /^[1-9]\d*$/.test(argument) && Number.isSafeInteger(Number(argument))) {
      result = await request('/api/observations/batch', { ids: [Number(argument)], project });
    } else {
      result = { help: 'Use save <note>, search <query>, or get <observation ID>. Project is configured on the server.' };
    }
  } catch (error) {
    // Explicit operations report failure; never retry an ambiguous write.
    result = { error: error.message };
  }
  await thread.post(JSON.stringify(result));
});
await bot.initialize();
const server = Bun.serve({
  hostname: '127.0.0.1', port,
  maxRequestBodySize: 65536,
  fetch(request) {
    if (new URL(request.url).pathname !== '/chat' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    return bot.webhooks.web(request);
  },
});
console.log(`Chat SDK memory demo listening on http://127.0.0.1:${server.port}/chat`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    server.stop(true);
    await bot.shutdown();
    process.exit(0);
  });
}
