import net from 'node:net';

const baseUrl = process.env.E2E_BASE_URL ?? 'http://claude-mem-server:37777';
const redisHost = process.env.E2E_REDIS_HOST ?? 'valkey';
const redisPort = Number.parseInt(process.env.E2E_REDIS_PORT ?? '6379', 10);
const phase = process.env.E2E_PHASE ?? 'phase1';
const apiKey = requiredEnv('E2E_API_KEY');
const readOnlyKey = process.env.E2E_READ_ONLY_API_KEY ?? '';
const revokedKey = process.env.E2E_REVOKED_API_KEY ?? '';
const runId = process.env.E2E_RUN_ID ?? `e2e-${Date.now()}`;
const projectRoot = `/tmp/claude-mem-server-beta-${runId}`;

function requiredEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const headers = {
    ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    ...(options.headers ?? {}),
  };
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? (options.json === undefined ? 'GET' : 'POST'),
    headers,
    body: options.json === undefined ? undefined : JSON.stringify(options.json),
  });
}

async function json(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Invalid JSON response (${response.status}): ${text}\n${error instanceof Error ? error.message : String(error)}`);
  }
}

async function requestJson(path, options = {}) {
  const response = await request(path, options);
  const body = await json(response);
  return { response, body };
}

async function expectStatus(path, status, options = {}) {
  const response = await request(path, options);
  assert(response.status === status, `${path} expected HTTP ${status}, got ${response.status}: ${await response.text()}`);
}

async function waitForReadiness() {
  const deadline = Date.now() + 120_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const health = await request('/healthz');
      const readiness = await request('/api/readiness');
      if (health.ok && readiness.ok) {
        return;
      }
      lastError = `health=${health.status} readiness=${readiness.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1000);
  }
  throw new Error(`Server did not become ready: ${lastError}`);
}

async function assertRedisPing() {
  const result = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: redisHost, port: redisPort });
    socket.setTimeout(3000);
    let data = '';
    socket.on('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'));
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.includes('PONG')) {
        socket.end();
        resolve(data);
      }
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Redis PING timed out'));
    });
    socket.on('error', reject);
    socket.on('close', () => {
      if (!data.includes('PONG')) {
        reject(new Error(`Redis PING failed: ${data}`));
      }
    });
  });
  assert(String(result).includes('PONG'), `Redis did not return PONG: ${result}`);
}

async function assertQueueHealth() {
  const { response, body } = await requestJson('/api/health');
  assert(response.ok, `/api/health expected OK, got ${response.status}`);
  assert(body.queue?.engine === 'bullmq', `expected BullMQ queue engine, got ${JSON.stringify(body.queue)}`);
  assert(body.queue?.redis?.status === 'ok', `expected Redis health ok, got ${JSON.stringify(body.queue?.redis)}`);
  assert(body.queue?.redis?.mode === 'docker', `expected docker Redis mode, got ${JSON.stringify(body.queue?.redis)}`);
}

async function phase1() {
  console.log(`[e2e] phase1 starting (${runId})`);
  await waitForReadiness();
  await assertQueueHealth();
  await assertRedisPing();

  await expectStatus('/v1/projects', 401, {
    method: 'POST',
    json: { name: 'unauthenticated' },
  });
  await expectStatus('/v1/projects', 403, {
    method: 'POST',
    apiKey: 'cmem_invalid_key',
    json: { name: 'invalid' },
  });
  if (readOnlyKey) {
    await expectStatus('/v1/projects', 403, {
      method: 'POST',
      apiKey: readOnlyKey,
      json: { name: 'read-only denied' },
    });
    const readOnlyProjects = await request('/v1/projects', { apiKey: readOnlyKey });
    assert(readOnlyProjects.ok, `read-only key should read projects, got ${readOnlyProjects.status}`);
  }

  const createdProject = await requestJson('/v1/projects', {
    apiKey,
    json: {
      name: `Server Beta E2E ${runId}`,
      rootPath: projectRoot,
      metadata: { runId },
    },
  });
  assert(createdProject.response.status === 201, `project create failed: ${JSON.stringify(createdProject.body)}`);
  const project = createdProject.body.project;
  assert(project?.id, 'project response missing id');

  const createdSession = await requestJson('/v1/sessions/start', {
    apiKey,
    json: {
      projectId: project.id,
      contentSessionId: `content-${runId}`,
      memorySessionId: `memory-${runId}`,
      platformSource: 'docker-e2e',
      title: 'Docker E2E session',
    },
  });
  assert(createdSession.response.status === 201, `session create failed: ${JSON.stringify(createdSession.body)}`);
  const session = createdSession.body.session;

  const createdEvent = await requestJson('/v1/events', {
    apiKey,
    json: {
      projectId: project.id,
      serverSessionId: session.id,
      sourceType: 'api',
      eventType: 'observation.created',
      contentSessionId: `content-${runId}`,
      memorySessionId: `memory-${runId}`,
      payload: { tool_name: 'Read', runId },
      occurredAtEpoch: Date.now(),
    },
  });
  assert(createdEvent.response.status === 201, `event create failed: ${JSON.stringify(createdEvent.body)}`);
  const event = createdEvent.body.event;

  const batchEvents = await requestJson('/v1/events/batch', {
    apiKey,
    json: [
      {
        projectId: project.id,
        sourceType: 'api',
        eventType: 'observation.created',
        payload: { index: 1, runId },
        occurredAtEpoch: Date.now(),
      },
      {
        projectId: project.id,
        sourceType: 'api',
        eventType: 'observation.created',
        payload: { index: 2, runId },
        occurredAtEpoch: Date.now(),
      },
    ],
  });
  assert(batchEvents.response.status === 201, `event batch failed: ${JSON.stringify(batchEvents.body)}`);
  assert(batchEvents.body.events.length === 2, 'event batch did not return two events');

  const fetchedEvent = await requestJson(`/v1/events/${event.id}`, { apiKey });
  assert(fetchedEvent.response.ok, `event fetch failed: ${JSON.stringify(fetchedEvent.body)}`);

  const createdMemory = await requestJson('/v1/memories', {
    apiKey,
    json: {
      projectId: project.id,
      serverSessionId: session.id,
      kind: 'manual',
      type: 'decision',
      title: `Docker E2E memory ${runId}`,
      narrative: `Server beta Docker E2E memory survives restart for ${runId}.`,
      facts: ['BullMQ health is backed by Valkey', `run:${runId}`],
      concepts: ['server-beta', 'docker-e2e'],
      metadata: { runId },
    },
  });
  assert(createdMemory.response.status === 201, `memory create failed: ${JSON.stringify(createdMemory.body)}`);
  const memory = createdMemory.body.memory;

  const patchedMemory = await requestJson(`/v1/memories/${memory.id}`, {
    method: 'PATCH',
    apiKey,
    json: {
      projectId: project.id,
      kind: 'manual',
      type: 'decision',
      narrative: `Patched Docker E2E memory survives restart for ${runId}.`,
      facts: ['patched', `run:${runId}`],
    },
  });
  assert(patchedMemory.response.ok, `memory patch failed: ${JSON.stringify(patchedMemory.body)}`);
  assert(patchedMemory.body.memory.narrative.includes('Patched'), 'patched memory narrative was not returned');

  const fetchedMemory = await requestJson(`/v1/memories/${memory.id}`, { apiKey });
  assert(fetchedMemory.response.ok, `memory fetch failed: ${JSON.stringify(fetchedMemory.body)}`);

  const search = await requestJson('/v1/search', {
    apiKey,
    json: { projectId: project.id, query: runId, limit: 10 },
  });
  assert(search.response.ok, `search failed: ${JSON.stringify(search.body)}`);
  assert(search.body.memories.some(item => item.id === memory.id), 'search did not return created memory');

  const context = await requestJson('/v1/context', {
    apiKey,
    json: { projectId: project.id, query: 'patched', limit: 5 },
  });
  assert(context.response.ok, `context failed: ${JSON.stringify(context.body)}`);
  assert(context.body.context.includes(runId), 'context did not include created memory text');

  const endedSession = await requestJson(`/v1/sessions/${session.id}/end`, {
    method: 'POST',
    apiKey,
    json: {},
  });
  assert(endedSession.response.ok, `session end failed: ${JSON.stringify(endedSession.body)}`);
  assert(endedSession.body.session.status === 'completed', 'session did not complete');

  const audit = await requestJson(`/v1/audit?projectId=${encodeURIComponent(project.id)}`, { apiKey });
  assert(audit.response.ok, `audit failed: ${JSON.stringify(audit.body)}`);
  assert(audit.body.audit.some(row => row.action === 'memory.write'), 'audit log missing memory.write');

  console.log(`[e2e] phase1 passed project=${project.id} memory=${memory.id}`);
}

async function phase2() {
  console.log(`[e2e] phase2 after restart starting (${runId})`);
  await waitForReadiness();
  await assertQueueHealth();
  await assertRedisPing();

  if (revokedKey) {
    await expectStatus('/v1/projects', 403, { apiKey: revokedKey });
  }

  const projects = await requestJson('/v1/projects', { apiKey });
  assert(projects.response.ok, `project list failed after restart: ${JSON.stringify(projects.body)}`);
  const project = projects.body.projects.find(item => item.rootPath === projectRoot);
  assert(project?.id, `persisted project not found for ${projectRoot}`);

  const search = await requestJson('/v1/search', {
    apiKey,
    json: { projectId: project.id, query: runId, limit: 10 },
  });
  assert(search.response.ok, `search failed after restart: ${JSON.stringify(search.body)}`);
  assert(search.body.memories.some(item => String(item.narrative ?? '').includes(runId)), 'persisted memory not found after restart');

  const audit = await requestJson(`/v1/audit?projectId=${encodeURIComponent(project.id)}`, { apiKey });
  assert(audit.response.ok, `audit failed after restart: ${JSON.stringify(audit.body)}`);
  assert(audit.body.audit.length > 0, 'audit log did not persist after restart');

  console.log(`[e2e] phase2 passed project=${project.id}`);
}

if (phase === 'phase1') {
  await phase1();
} else if (phase === 'phase2') {
  await phase2();
} else {
  throw new Error(`Unknown E2E_PHASE: ${phase}`);
}
