import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  _resetRedactionConfigCache,
  getRedactionConfig,
  redactForLog,
  redactJsonStrings,
} from '../../src/utils/redaction.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { summarizeRequestBody } from '../../src/services/worker/http/middleware.js';
import { observationHandler } from '../../src/cli/handlers/observation.js';
import { logger } from '../../src/utils/logger.js';

const OPENAI_KEY = 'sk-ABCDEFGHIJ1234567890abcdef';
const MARKER = "<redacted type='openai_key'/>";

function settingsFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'redaction-settings-')), 'settings.json');
  writeFileSync(path, contents);
  return path;
}

describe('an unreadable settings.json does not silently turn redaction off', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    _resetRedactionConfigCache();
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    setSystemTime();
    _resetRedactionConfigCache();
  });

  it('keeps the built-in patterns on when the broken file still asks for redaction', () => {
    const config = getRedactionConfig(settingsFile('{"CLAUDE_MEM_REDACT_ENABLED": "true",, }'));
    expect(config.enabled).toBe(true);
    expect(config.disabledBuiltinPatterns).toEqual([]);
  });

  it('stays off when the broken file never asked for it', () => {
    expect(getRedactionConfig(settingsFile('{"CLAUDE_MEM_LOG_LEVEL": "INFO",, }')).enabled).toBe(false);
  });

  it('keeps the last configuration that loaded, custom patterns included, when the file breaks later', () => {
    setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    const customPatterns = [{ name: 'internal', regex: 'INTERNAL-[0-9]{4}' }];
    const path = settingsFile(JSON.stringify({
      CLAUDE_MEM_REDACT_ENABLED: 'true',
      CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: JSON.stringify(customPatterns),
    }));
    expect(getRedactionConfig(path).customPatterns).toEqual(customPatterns);

    writeFileSync(path, '{ "CLAUDE_MEM_LOG_LEVEL": ');
    setSystemTime(new Date('2026-10-01T00:00:10.000Z')); // past the 5 s config cache
    const config = getRedactionConfig(path);
    expect(config.enabled).toBe(true);
    expect(config.customPatterns).toEqual(customPatterns);
  });

  it('still honors a readable file that leaves redaction off', () => {
    expect(getRedactionConfig(settingsFile(JSON.stringify({ CLAUDE_MEM_REDACT_ENABLED: 'false' }))).enabled).toBe(false);
  });
});

describe('redactJsonStrings (server runtime event payloads)', () => {
  it('redacts every string in a JSON payload, at any depth, and keeps its shape', () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: `curl -H "Authorization: Bearer ${OPENAI_KEY}"` },
      tool_response: [`out ${OPENAI_KEY}`, 3, null, true],
    };
    expect(redactJsonStrings(payload, { enabled: true })).toEqual({
      tool_name: 'Bash',
      tool_input: { command: `curl -H "Authorization: Bearer ${MARKER}"` },
      tool_response: [`out ${MARKER}`, 3, null, true],
    });
    expect(payload.tool_input.command).toContain(OPENAI_KEY); // the caller's object is not mutated
  });

  it('returns the payload itself while redaction is off', () => {
    const payload = { token: OPENAI_KEY };
    expect(redactJsonStrings(payload, { enabled: false })).toBe(payload);
  });
});

describe('tool summaries in logs are redacted while redaction is on', () => {
  let loadSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    loadSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_REDACT_ENABLED: 'true',
    }));
    _resetRedactionConfigCache();
  });
  afterEach(() => {
    loadSpy.mockRestore();
    _resetRedactionConfigCache();
  });

  it('redactForLog replaces a secret in a log line', () => {
    expect(redactForLog(`Bash(curl -H "Authorization: Bearer ${OPENAI_KEY}")`)).toBe(`Bash(curl -H "Authorization: Bearer ${MARKER}")`);
  });

  it('the worker request log summarizes a Bash command without its secret', () => {
    const summary = summarizeRequestBody('POST', '/api/sessions/observations', {
      tool_name: 'Bash',
      tool_input: { command: `export OPENAI_API_KEY=${OPENAI_KEY}` },
    });
    expect(summary).toBe(`tool=Bash(export OPENAI_API_KEY=${MARKER})`);
  });

  it('the PostToolUse hook logs the Bash command without its secret', async () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => {});
    try {
      // No cwd: the handler logs the tool line, then refuses the input.
      await expect(observationHandler.execute({
        sessionId: 'session-1',
        toolName: 'Bash',
        toolInput: { command: `curl -H "Authorization: Bearer ${OPENAI_KEY}" https://api.example.com` },
        platform: 'claude-code',
      } as never)).rejects.toThrow('Missing cwd');
      const logged = infoSpy.mock.calls.map(call => String(call[1])).join('\n');
      expect(logged).toContain(MARKER);
      expect(logged).not.toContain(OPENAI_KEY);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
