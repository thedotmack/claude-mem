import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  explainTelemetryConsent, getOrCreateAnonymousDistinctId, getOrCreateInstallId,
  loadTelemetryConfig, saveTelemetryConfig,
} from '../../src/services/telemetry/consent.js';

function inDataDirectory(run: () => void) {
  const previous = process.env.CLAUDE_MEM_DATA_DIR;
  const directory = mkdtempSync(join(tmpdir(), 'telemetry-id-consent-'));
  process.env.CLAUDE_MEM_DATA_DIR = directory;
  try { run(); } finally {
    if (previous === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [kind, createId] of [
  ['install', getOrCreateInstallId], ['anonymous', getOrCreateAnonymousDistinctId],
] as const) {
  test(`creating a missing ${kind} ID preserves a recorded opt-out`, () => inDataDirectory(() => {
    const decidedAt = '2026-11-01T00:00:00.000Z';
    // telemetry disable before any events writes this valid config. An env
    // override may permit one run without changing the saved preference.
    saveTelemetryConfig({ enabled: false, installId: '', decidedAt });
    assert.equal(explainTelemetryConsent({ CLAUDE_MEM_TELEMETRY: '1' }, loadTelemetryConfig()).enabled, true);
    assert.ok(createId());
    const saved = loadTelemetryConfig();
    assert.equal(saved?.enabled, false);
    assert.equal(saved?.decidedAt, decidedAt);
    assert.equal(explainTelemetryConsent({}, saved).enabled, false);
  }));
}

test('existing identities and recorded consent remain stable', () => inDataDirectory(() => {
  saveTelemetryConfig({ enabled: false, installId: 'install-id', anonymousId: 'anonymous-id', decidedAt: 'decision' });
  assert.equal(getOrCreateInstallId(), 'install-id');
  assert.equal(getOrCreateAnonymousDistinctId(), 'anonymous-id');
  assert.deepEqual(loadTelemetryConfig(), {
    enabled: false, installId: 'install-id', anonymousId: 'anonymous-id', decidedAt: 'decision',
  });
}));
