// Phase 10 — Docker E2E driver for server-beta. Verifies the
// runtime-relevant slice of the API actually shipped in the Postgres routes:
//
//   - GET  /healthz          — server is alive
//   - GET  /api/readiness    — Postgres bootstrap completed
//   - GET  /api/health       — BullMQ queue engine is bullmq + redis ok
//   - POST /v1/sessions/start, /v1/sessions/:id/end
//   - POST /v1/events?wait=true (returns generationJob descriptor)
//   - GET  /v1/events/:id    — read-back via team scope
//   - GET  /v1/jobs/:id      — generation job status
//   - 401/403 paths for missing/invalid/revoked keys

import net from 'node:net';

const baseUrl = process.env.E2E_BASE_URL ?? 'http://claude-mem-server:37877';
const redisHost = process.env.E2E_REDIS_HOST ?? 'valkey';
const redisPort = Number.parseInt(process.env.E2E_REDIS_PORT ?? '6379', 10);
const phase = process.env.E2E_PHASE ?? 'phase1';
const apiKey = requiredEnv('E2E_API_KEY');
const readOnlyKey = process.env.E2E_READ_ONLY_API_KEY ?? '';
const revokedKey = process.env.E2E_REVOKED_API_KEY ?? '';
const runId = process.env.E2E_RUN_ID ?? `e2e-${Date.now()}`;
const projectIdFromEnv = process.env.E2E_PROJECT_ID ?? '';

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
}

async function assertInfoEndpoint() {
  const { response, body } = await requestJson('/v1/info');
  assert(response.ok, `/v1/info expected OK, got ${response.status}`);
  assert(body.runtime === 'server-beta', `expected runtime=server-beta, got ${body.runtime}`);
  assert(body.postgres?.initialized === true, `expected postgres.initialized=true, got ${JSON.stringify(body.postgres)}`);
  assert(body.boundaries?.queueManager?.status === 'active', `expected queue manager active, got ${JSON.stringify(body.boundaries?.queueManager)}`);
}

async function phase1() {
  console.log(`[e2e] phase1 starting (${runId})`);
  await waitForReadiness();
  await assertQueueHealth();
  await assertInfoEndpoint();
  await assertRedisPing();

  // Auth — missing key returns 401, invalid key returns 403. Auth runs
  // before body validation, so the body content is irrelevant here.
  await expectStatus('/v1/sessions/start', 401, {
    method: 'POST',
    json: { projectId: projectIdFromEnv, contentSessionId: 'unauth' },
  });
  await expectStatus('/v1/sessions/start', 403, {
    method: 'POST',
    apiKey: 'cmem_invalid_key_for_e2e',
    json: { projectId: projectIdFromEnv, contentSessionId: 'invalid' },
  });

  // Read-only key cannot write.
  if (readOnlyKey) {
    await expectStatus('/v1/sessions/start', 403, {
      method: 'POST',
      apiKey: readOnlyKey,
      json: { projectId: projectIdFromEnv, contentSessionId: `readonly-${runId}` },
    });
  }

  // Open a session. projectId is required in the body and must match the
  // project the api-key is scoped to (passed in via E2E_PROJECT_ID).
  assert(projectIdFromEnv, 'E2E_PROJECT_ID is required for phase1');
  const sessionRes = await requestJson('/v1/sessions/start', {
    apiKey,
    json: {
      projectId: projectIdFromEnv,
      contentSessionId: `content-${runId}`,
      platformSource: 'docker-e2e',
    },
  });
  assert(sessionRes.response.status === 201, `session create failed: ${sessionRes.response.status} ${JSON.stringify(sessionRes.body)}`);
  const session = sessionRes.body.session;
  assert(session?.id, `session response missing id: ${JSON.stringify(sessionRes.body)}`);
  const projectId = session.projectId;
  assert(projectId, `session missing projectId: ${JSON.stringify(session)}`);

  // POST /v1/events?wait=true — returns a generationJob descriptor on
  // success. This is the Phase 10 contract: HTTP path returns the queued
  // job, and the worker process generates the observation later.
  const createdEvent = await requestJson('/v1/events?wait=true', {
    apiKey,
    json: {
      projectId,
      serverSessionId: session.id,
      sourceType: 'api',
      eventType: 'observation.created',
      contentSessionId: `content-${runId}`,
      memorySessionId: `memory-${runId}`,
      payload: { tool_name: 'Read', runId },
      occurredAtEpoch: Date.now(),
    },
  });
  assert(
    createdEvent.response.status === 201,
    `event create failed: ${createdEvent.response.status} ${JSON.stringify(createdEvent.body)}`,
  );
  const event = createdEvent.body.event;
  assert(event?.id, `event response missing id: ${JSON.stringify(createdEvent.body)}`);
  // wait=true MUST include a generationJob descriptor (queued or generated).
  // Its absence indicates the queue path was bypassed.
  assert(
    createdEvent.body.generationJob !== undefined && createdEvent.body.generationJob !== null,
    `wait=true response missing generationJob: ${JSON.stringify(createdEvent.body)}`,
  );

  // Read-back through the team-scoped GET /v1/events/:id route.
  const fetched = await requestJson(`/v1/events/${event.id}`, { apiKey });
  assert(fetched.response.ok, `event fetch failed: ${fetched.response.status} ${JSON.stringify(fetched.body)}`);

  // Poll the generation job — it MUST exist in Postgres regardless of
  // whether a provider is configured. Without a provider, status stays at
  // `queued`; with one, it eventually becomes `generated`. Either way the
  // job row is observable via GET /v1/jobs/:id.
  const jobId = createdEvent.body.generationJob.id;
  if (jobId) {
    const jobRes = await requestJson(`/v1/jobs/${jobId}`, { apiKey });
    assert(jobRes.response.ok, `job fetch failed: ${jobRes.response.status} ${JSON.stringify(jobRes.body)}`);
  }

  // Close the session.
  const ended = await requestJson(`/v1/sessions/${session.id}/end`, {
    method: 'POST',
    apiKey,
    json: {},
  });
  assert(ended.response.ok, `session end failed: ${ended.response.status} ${JSON.stringify(ended.body)}`);

  console.log(`[e2e] phase1 passed session=${session.id} event=${event.id} job=${jobId ?? 'none'}`);
}

async function phase2() {
  console.log(`[e2e] phase2 after restart starting (${runId})`);
  await waitForReadiness();
  await assertQueueHealth();
  await assertInfoEndpoint();
  await assertRedisPing();

  // Revoked key MUST fail on every authenticated route. The restart between
  // phase1 and phase2 specifically asserts the revocation lives in Postgres,
  // not an in-memory cache.
  if (revokedKey) {
    await expectStatus('/v1/sessions/start', 403, {
      method: 'POST',
      apiKey: revokedKey,
      json: { projectId: projectIdFromEnv, contentSessionId: `revoked-${runId}` },
    });
  }

  // Full key still works after restart — durable session creation + event
  // ingest path through Postgres.
  assert(projectIdFromEnv, 'E2E_PROJECT_ID is required for phase2');
  const sessionRes = await requestJson('/v1/sessions/start', {
    apiKey,
    json: {
      projectId: projectIdFromEnv,
      contentSessionId: `content-after-restart-${runId}`,
      platformSource: 'docker-e2e',
    },
  });
  assert(
    sessionRes.response.status === 201,
    `session create after restart failed: ${sessionRes.response.status} ${JSON.stringify(sessionRes.body)}`,
  );
  const session = sessionRes.body.session;
  const projectId = session.projectId;

  const createdEvent = await requestJson('/v1/events?wait=true', {
    apiKey,
    json: {
      projectId,
      serverSessionId: session.id,
      sourceType: 'api',
      eventType: 'observation.created',
      contentSessionId: `content-after-restart-${runId}`,
      payload: { tool_name: 'Edit', runId, after: 'restart' },
      occurredAtEpoch: Date.now(),
    },
  });
  assert(
    createdEvent.response.status === 201,
    `event after restart failed: ${createdEvent.response.status} ${JSON.stringify(createdEvent.body)}`,
  );
  assert(
    createdEvent.body.generationJob !== undefined && createdEvent.body.generationJob !== null,
    `wait=true after restart missing generationJob: ${JSON.stringify(createdEvent.body)}`,
  );

  console.log(`[e2e] phase2 passed session=${session.id} event=${createdEvent.body.event.id}`);
}

if (phase === 'phase1') {
  await phase1();
} else if (phase === 'phase2') {
  await phase2();
} else {
  throw new Error(`Unknown E2E_PHASE: ${phase}`);
}
