import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractPriorMessages } from '../../src/services/context/ObservationCompiler.js';
import { renderPreviouslySection } from '../../src/services/context/sections/PreviouslyRenderer.js';
import { _resetRedactionConfigCache } from '../../src/utils/redaction.js';

function line(...text: string[]) {
  return JSON.stringify({ type: 'assistant', message: { content: text.map(value => ({ type: 'text', text: value })) } });
}

function fixture(lines: string[], run: (path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mem-prior-privacy-'));
  const path = join(directory, 'session.jsonl');
  const transcript = lines.join('\n') + '\n';
  writeFileSync(path, transcript);
  try {
    run(path);
    // Projection must not rewrite the host's raw transcript.
    expect(readFileSync(path, 'utf8')).toBe(transcript);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('prior-session context privacy', () => {
  it('removes private blocks across text parts before rendering the previous reply', () => {
    fixture([line('Public answer. <private>hidden', ' value</private> Public conclusion.')], path => {
      const prior = extractPriorMessages(path);
      expect(prior.assistantMessage).toBe('Public answer.  Public conclusion.');
      for (const human of [false, true]) {
        const rendered = renderPreviouslySection(prior, human).join('\n');
        expect(rendered).not.toContain('hidden');
        expect(rendered).toContain('Public conclusion.');
      }
    });
  });

  it('does not treat a private-only latest reply as usable prior context', () => {
    fixture([line('Earlier public answer'), line('<private>Private latest answer</private>')], path => {
      expect(extractPriorMessages(path).assistantMessage).toBe('Earlier public answer');
    });
    fixture([line('<private>Private-only session</private>')], path => {
      expect(extractPriorMessages(path).assistantMessage).toBe('');
    });
  });

  it('removes injected memory and persisted output while preserving ordinary prose', () => {
    fixture([line('Useful text <claude-mem-context>Old injected memory</claude-mem-context>'
      + '<persisted-output>Raw hidden tool output</persisted-output> <example>Keep this XML</example>')], path => {
      expect(extractPriorMessages(path).assistantMessage).toBe('Useful text  <example>Keep this XML</example>');
    });
  });

  it('honors the current opt-in secret redaction setting for raw prior replies', () => {
    const previous = process.env.CLAUDE_MEM_REDACT_ENABLED;
    const fakeKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
    try {
      fixture([line(`Credential ${fakeKey} was rotated.`)], path => {
        process.env.CLAUDE_MEM_REDACT_ENABLED = 'true';
        _resetRedactionConfigCache();
        const redacted = extractPriorMessages(path).assistantMessage;
        expect(redacted).not.toContain(fakeKey);
        expect(redacted).toContain("<redacted type='aws_access_key'/>");
        process.env.CLAUDE_MEM_REDACT_ENABLED = 'false';
        _resetRedactionConfigCache();
        expect(extractPriorMessages(path).assistantMessage).toContain(fakeKey);
      });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MEM_REDACT_ENABLED;
      else process.env.CLAUDE_MEM_REDACT_ENABLED = previous;
      _resetRedactionConfigCache();
    }
  });
});
