
import { describe, it, expect, beforeAll, beforeEach, afterAll, spyOn } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { logger } from '../../src/utils/logger.js';
import { Server } from '../../src/services/server/Server.js';
import { WorkerService } from '../../src/services/worker-service.js';
import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { BOTTLES_DIR, USER_SETTINGS_PATH } from '../../src/shared/paths.js';

// The preload (tests/preload.ts) pins CLAUDE_MEM_DATA_DIR to a per-run temp
// dir before any module loads, so BOTTLES_DIR / USER_SETTINGS_PATH / DB_PATH
// all resolve inside it — no test ever touches the real ~/.claude-mem.
const SEEDED_SESSION_ID = 'render-bottle-endpoint-waited';
const QUEUED_SESSION_ID = 'render-bottle-endpoint-queued';
const SEEDED_PROMPT_TEXT = 'Wire the render-bottle endpoint';

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let server: Server;
let dbManager: DatabaseManager;
let testPort: number;
let originalSettingsJson: string | null = null;

function writeUserSettings(overrides: Record<string, string>): void {
  writeFileSync(
    USER_SETTINGS_PATH,
    JSON.stringify({ CLAUDE_MEM_CHROMA_ENABLED: 'false', ...overrides }, null, 2)
  );
}

async function postRenderBottle(body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${testPort}/api/sessions/render-bottle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The bottle embeds its render time; normalize it so idempotency compares
// everything BUT the timestamp.
function normalizeRenderedTimestamp(bottleMarkdown: string): string {
  return bottleMarkdown.replace(/rendered: [^\n]+/, 'rendered: <normalized>');
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return existsSync(filePath);
}

describe('POST /api/sessions/render-bottle', () => {
  beforeAll(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    originalSettingsJson = existsSync(USER_SETTINGS_PATH)
      ? readFileSync(USER_SETTINGS_PATH, 'utf-8')
      : null;
    writeUserSettings({});

    const worker = new WorkerService();
    server = (worker as unknown as { server: Server }).server;
    dbManager = (worker as unknown as { dbManager: DatabaseManager }).dbManager;
    await dbManager.initialize();
    (worker as unknown as { initializationCompleteFlag: boolean }).initializationCompleteFlag = true;

    const store = dbManager.getSessionStore();
    const seededSessionDbId = store.createSDKSession(SEEDED_SESSION_ID, 'render-bottle-test', SEEDED_PROMPT_TEXT);
    store.saveUserPrompt(SEEDED_SESSION_ID, 1, SEEDED_PROMPT_TEXT, seededSessionDbId);
    const queuedSessionDbId = store.createSDKSession(QUEUED_SESSION_ID, 'render-bottle-test', SEEDED_PROMPT_TEXT);
    store.saveUserPrompt(QUEUED_SESSION_ID, 1, SEEDED_PROMPT_TEXT, queuedSessionDbId);

    testPort = 40000 + Math.floor(Math.random() * 10000);
    await server.listen(testPort, '127.0.0.1');
  });

  beforeEach(() => {
    writeUserSettings({});
  });

  afterAll(async () => {
    if (originalSettingsJson === null) {
      rmSync(USER_SETTINGS_PATH, { force: true });
    } else {
      writeFileSync(USER_SETTINGS_PATH, originalSettingsJson);
    }

    if (server && server.getHttpServer()) {
      try {
        await server.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    await dbManager.close();

    loggerSpies.forEach(spy => spy.mockRestore());
  });

  it('wait:true renders the bottle and returns its path', async () => {
    const response = await postRenderBottle({ contentSessionId: SEEDED_SESSION_ID, wait: true });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.bottlePath).toBe(path.join(BOTTLES_DIR, `${SEEDED_SESSION_ID}.md`));
    expect(body.mode).toBe('reconstructed');
    expect(existsSync(body.bottlePath)).toBe(true);
    expect(readFileSync(body.bottlePath, 'utf-8')).toContain(SEEDED_PROMPT_TEXT);
  });

  it('rejects a missing body with 400 ValidationError', async () => {
    const response = await postRenderBottle({});
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe('ValidationError');
  });

  it('returns {status:disabled} when CLAUDE_MEM_ENDLESS_MODE_ENABLED is false', async () => {
    writeUserSettings({ CLAUDE_MEM_ENDLESS_MODE_ENABLED: 'false' });

    const response = await postRenderBottle({ contentSessionId: SEEDED_SESSION_ID, wait: true });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ status: 'disabled' });
  });

  it('returns {status:nothing_to_render} for an unknown session with no data', async () => {
    const response = await postRenderBottle({
      contentSessionId: 'render-bottle-endpoint-unknown',
      wait: true,
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ status: 'nothing_to_render' });
    expect(existsSync(path.join(BOTTLES_DIR, 'render-bottle-endpoint-unknown.md'))).toBe(false);
  });

  it('double wait:true POST is idempotent modulo the rendered timestamp', async () => {
    const firstResponse = await postRenderBottle({ contentSessionId: SEEDED_SESSION_ID, wait: true });
    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json();
    const firstBottleMarkdown = readFileSync(firstBody.bottlePath, 'utf-8');

    const secondResponse = await postRenderBottle({ contentSessionId: SEEDED_SESSION_ID, wait: true });
    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json();
    const secondBottleMarkdown = readFileSync(secondBody.bottlePath, 'utf-8');

    expect(secondBody).toEqual(firstBody);
    expect(normalizeRenderedTimestamp(secondBottleMarkdown)).toBe(normalizeRenderedTimestamp(firstBottleMarkdown));
  });

  // Backgroundness itself (response flushes before the render runs) comes
  // from the setImmediate yield in handleRenderBottle's no-wait branch and is
  // not observable over HTTP without mocks — this proves the contract only:
  // immediate queued response, render completes asynchronously afterwards.
  it('default (no wait) responds {status:queued} and the render completes asynchronously', async () => {
    const bottlePath = path.join(BOTTLES_DIR, `${QUEUED_SESSION_ID}.md`);
    expect(existsSync(bottlePath)).toBe(false);

    const response = await postRenderBottle({ contentSessionId: QUEUED_SESSION_ID });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ status: 'queued' });

    expect(await waitForFile(bottlePath, 5000)).toBe(true);
    expect(readFileSync(bottlePath, 'utf-8')).toContain(SEEDED_PROMPT_TEXT);
  });
});
