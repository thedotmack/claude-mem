import { describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  removeObserverTranscriptForSession,
  resolveObserverTranscriptPath,
} from '../../src/services/worker/session/ObserverTranscriptCleanup.js';

function makeLayout(): { claudeConfigDir: string; observerSessionsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-observer-cleanup-'));
  return {
    claudeConfigDir: join(root, 'claude-config'),
    observerSessionsDir: join(root, '.claude-mem', 'observer-sessions'),
  };
}

function requireTranscriptPath(
  sessionId: string,
  layout: ReturnType<typeof makeLayout>,
): string {
  const transcriptPath = resolveObserverTranscriptPath(
    sessionId,
    layout.claudeConfigDir,
    layout.observerSessionsDir,
  );
  if (!transcriptPath) throw new Error('expected canonical observer transcript path');
  mkdirSync(dirname(transcriptPath), { recursive: true });
  return transcriptPath;
}

describe('completed observer transcript cleanup', () => {
  it('deletes only the canonical UUID JSONL in the observer project directory', async () => {
    const layout = makeLayout();
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const transcriptPath = requireTranscriptPath(sessionId, layout);
    writeFileSync(transcriptPath, '{"type":"user"}\n');

    const result = await removeObserverTranscriptForSession(
      sessionId,
      layout.claudeConfigDir,
      layout.observerSessionsDir,
    );

    expect(result).toBe('deleted');
    expect(existsSync(transcriptPath)).toBe(false);
  });

  it('treats an absent canonical transcript as already clean', async () => {
    const layout = makeLayout();
    const result = await removeObserverTranscriptForSession(
      '22222222-2222-4222-8222-222222222222',
      layout.claudeConfigDir,
      layout.observerSessionsDir,
    );

    expect(result).toBe('missing');
  });

  it('rejects malformed and traversal session IDs', async () => {
    const layout = makeLayout();

    expect(resolveObserverTranscriptPath('../outside', layout.claudeConfigDir, layout.observerSessionsDir)).toBeNull();
    expect(await removeObserverTranscriptForSession('../outside', layout.claudeConfigDir, layout.observerSessionsDir)).toBe('invalid');
  });

  it('does not unlink a symlink even when its name is a canonical UUID', async () => {
    const layout = makeLayout();
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const transcriptPath = requireTranscriptPath(sessionId, layout);
    const outsideTarget = join(dirname(dirname(transcriptPath)), 'outside.jsonl');
    writeFileSync(outsideTarget, 'keep');
    symlinkSync(outsideTarget, transcriptPath);

    const result = await removeObserverTranscriptForSession(
      sessionId,
      layout.claudeConfigDir,
      layout.observerSessionsDir,
    );

    expect(result).toBe('unsafe');
    expect(existsSync(transcriptPath)).toBe(true);
    expect(existsSync(outsideTarget)).toBe(true);
  });

  it('does not follow a symlinked observer project directory', async () => {
    const layout = makeLayout();
    const sessionId = '44444444-4444-4444-8444-444444444444';
    const transcriptPath = resolveObserverTranscriptPath(
      sessionId,
      layout.claudeConfigDir,
      layout.observerSessionsDir,
    );
    if (!transcriptPath) throw new Error('expected canonical observer transcript path');

    const observerProjectDir = dirname(transcriptPath);
    const outsideProjectDir = join(dirname(layout.claudeConfigDir), 'outside-observer-project');
    const outsideTranscript = join(outsideProjectDir, `${sessionId}.jsonl`);
    mkdirSync(dirname(observerProjectDir), { recursive: true });
    mkdirSync(outsideProjectDir, { recursive: true });
    writeFileSync(outsideTranscript, 'keep');
    symlinkSync(outsideProjectDir, observerProjectDir, 'dir');

    const result = await removeObserverTranscriptForSession(
      sessionId,
      layout.claudeConfigDir,
      layout.observerSessionsDir,
    );

    expect(result).toBe('unsafe');
    expect(existsSync(outsideTranscript)).toBe(true);
  });
});
