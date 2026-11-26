// #6503: there was no switch that turned the oversized-field condense pass off
// by itself. The only workaround was CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS=500,
// which still starts (and may be billed for) the request before aborting it.
// CLAUDE_MEM_FIELD_CONDENSE_ENABLED=false skips the model call entirely, so an
// oversized field goes straight to the prompt builder's head/tail elision.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  optimizeField,
  optimizeObservationFields,
  type FieldCompressor,
} from '../../src/services/worker/field-optimizer.js';
import { resolveFieldCondenseEnabled } from '../../src/services/worker/retry.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const CTX = { sessionDbId: 1, field: 'outcome', toolName: 'Read' };
const MAX = 200;
const oversized = { body: 'x'.repeat(MAX * 3) };

function countingCompressor(): { compress: FieldCompressor; calls: () => number } {
  let calls = 0;
  return {
    compress: async () => { calls++; return { text: 'condensed', truncated: false }; },
    calls: () => calls,
  };
}

describe('resolveFieldCondenseEnabled', () => {
  let settingsDir: string;
  let settingsPath: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(join(tmpdir(), 'field-condense-'));
    settingsPath = join(settingsDir, 'settings.json');
    writeFileSync(settingsPath, '{}');
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  const writeSettings = (settings: Record<string, unknown>) =>
    writeFileSync(settingsPath, JSON.stringify(settings));

  it('is on by default, so existing installs keep condensing', () => {
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_FIELD_CONDENSE_ENABLED).toBe('true');
    expect(resolveFieldCondenseEnabled({}, settingsPath)).toBe(true);
  });

  it('reads false from settings.json', () => {
    writeSettings({ CLAUDE_MEM_FIELD_CONDENSE_ENABLED: 'false' });
    expect(resolveFieldCondenseEnabled({}, settingsPath)).toBe(false);
  });

  it('accepts a JSON boolean false written by hand', () => {
    writeSettings({ CLAUDE_MEM_FIELD_CONDENSE_ENABLED: false });
    expect(resolveFieldCondenseEnabled({}, settingsPath)).toBe(false);
  });

  it('lets the environment variable override settings.json', () => {
    writeSettings({ CLAUDE_MEM_FIELD_CONDENSE_ENABLED: 'true' });
    expect(resolveFieldCondenseEnabled({ CLAUDE_MEM_FIELD_CONDENSE_ENABLED: 'false' }, settingsPath)).toBe(false);
    writeSettings({ CLAUDE_MEM_FIELD_CONDENSE_ENABLED: 'false' });
    expect(resolveFieldCondenseEnabled({ CLAUDE_MEM_FIELD_CONDENSE_ENABLED: 'true' }, settingsPath)).toBe(true);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(resolveFieldCondenseEnabled({ CLAUDE_MEM_FIELD_CONDENSE_ENABLED: ' FALSE ' }, settingsPath)).toBe(false);
  });

  // Only an explicit "false" turns it off: a typo must not silently change
  // what the observer records.
  it('keeps condensing on any value other than false', () => {
    expect(resolveFieldCondenseEnabled({ CLAUDE_MEM_FIELD_CONDENSE_ENABLED: 'no' }, settingsPath)).toBe(true);
    expect(resolveFieldCondenseEnabled({ CLAUDE_MEM_FIELD_CONDENSE_ENABLED: '' }, settingsPath)).toBe(true);
  });
});

describe('optimizeField with condensing switched off', () => {
  it('never calls the model and returns the oversized field for elision', async () => {
    const { compress, calls } = countingCompressor();
    expect(await optimizeField(oversized, compress, CTX, MAX, 10_000, undefined, undefined, false)).toBe(oversized);
    expect(calls()).toBe(0);
  });

  it('accepts a lazy switch, read only when a field is actually oversized', async () => {
    let reads = 0;
    const enabled = () => { reads++; return false; };
    const { compress, calls } = countingCompressor();

    await optimizeField({ small: 'fits' }, compress, CTX, MAX, 10_000, undefined, undefined, enabled);
    expect(reads).toBe(0);

    expect(await optimizeField(oversized, compress, CTX, MAX, 10_000, undefined, undefined, enabled)).toBe(oversized);
    expect(reads).toBe(1);
    expect(calls()).toBe(0);
  });

  it('still condenses when the switch is on', async () => {
    const { compress, calls } = countingCompressor();
    const out = await optimizeField(oversized, compress, CTX, MAX, 10_000, undefined, undefined, () => true);
    expect(String(out)).toContain('<condensed');
    expect(calls()).toBe(1);
  });

  it('leaves both observation fields to elision without any model call', async () => {
    const { compress, calls } = countingCompressor();
    const out = await optimizeObservationFields(
      { toolInput: oversized, toolOutput: oversized },
      compress,
      { sessionDbId: 1, toolName: 'Bash' },
      MAX,
      10_000,
      undefined,
      undefined,
      false,
    );
    expect(out).toEqual({ toolInput: oversized, toolOutput: oversized });
    expect(calls()).toBe(0);
  });
});
