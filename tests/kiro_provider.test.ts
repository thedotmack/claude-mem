import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, rmSync, existsSync, readFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cleanKiroChatOutput,
  flattenConversation,
  findKiroCliExecutable,
  isKiroSelected,
} from '../src/services/worker/KiroProvider.js';
import { USER_SETTINGS_PATH } from '../src/shared/paths.js';
import type { ConversationMessage } from '../src/services/worker-types.js';

let previousSettingsContent: string | null;

beforeEach(() => {
  previousSettingsContent = existsSync(USER_SETTINGS_PATH) ? readFileSync(USER_SETTINGS_PATH, 'utf-8') : null;
});

afterEach(() => {
  if (previousSettingsContent === null) {
    rmSync(USER_SETTINGS_PATH, { force: true });
  } else {
    writeFileSync(USER_SETTINGS_PATH, previousSettingsContent);
  }
});

describe('cleanKiroChatOutput', () => {
  it('reduces a live-captured headless stream to the model text', () => {
    // Shape observed on kiro-cli 2.11.0: ANSI colours, cursor-visibility
    // codes, "> " prompt prefix, credits footer.
    const raw = '\n\u001b[38;5;252m\u001b[0m\u001b[?25l\u001b[38;5;141m> \u001b[0mpong\u001b[0m\u001b[0m\n\u001b[38;5;8m\n ▸ Credits: 0.05 • Time: 1s\n\n\u001b[0m\u001b[1G\u001b[0m\u001b[0m\u001b[?25h';

    expect(cleanKiroChatOutput(raw)).toBe('pong');
  });

  it('keeps multi-line structured output intact', () => {
    const raw = '\u001b[38;5;141m> \u001b[0m<observation>\n<title>Fixed bug</title>\n</observation>\n ▸ Credits: 0.03 • Time: 2s\n';

    expect(cleanKiroChatOutput(raw)).toBe('<observation>\n<title>Fixed bug</title>\n</observation>');
  });

  it('drops hook spinner lines without touching content', () => {
    const raw = '⠋ 0 of 1 hooks finished\n✓ 1 of 1 hooks finished in 0.17 s\n> answer text\n';

    expect(cleanKiroChatOutput(raw)).toBe('answer text');
  });

  it('returns empty string for effectively empty output', () => {
    expect(cleanKiroChatOutput('\u001b[0m\n ▸ Credits: 0.01 • Time: 1s\n')).toBe('');
  });
});

describe('flattenConversation', () => {
  it('passes a single message through unchanged', () => {
    const history: ConversationMessage[] = [{ role: 'user', content: 'init prompt' }];

    expect(flattenConversation(history)).toBe('init prompt');
  });

  it('replays prior turns as a labelled transcript before the current instruction', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'second' },
    ];

    const flattened = flattenConversation(history);
    expect(flattened).toContain('[PREVIOUS INSTRUCTION]\nfirst');
    expect(flattened).toContain('[YOUR PREVIOUS RESPONSE]\nack');
    expect(flattened.endsWith('[CURRENT INSTRUCTION — respond to this]\nsecond')).toBe(true);
  });
});

describe('provider selection & CLI resolution', () => {
  it('isKiroSelected follows CLAUDE_MEM_PROVIDER', () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'kiro' }));
    expect(isKiroSelected()).toBe(true);

    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'claude' }));
    expect(isKiroSelected()).toBe(false);
  });

  it('findKiroCliExecutable honours the CLAUDE_MEM_KIRO_CLI_PATH override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-cli-fake-'));
    const fakeCli = join(dir, 'kiro-cli');
    writeFileSync(fakeCli, '#!/bin/sh\n');
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ CLAUDE_MEM_KIRO_CLI_PATH: fakeCli }));

    expect(findKiroCliExecutable()).toBe(fakeCli);
    rmSync(dir, { recursive: true, force: true });
  });
});
