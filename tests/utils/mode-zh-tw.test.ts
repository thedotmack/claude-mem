/**
 * Regression test for missing zh-TW mode file (#1364)
 *
 * code--zh-TW mode was silently falling back to code--zh (Simplified Chinese)
 * because code--zh-tw.json did not exist. This test verifies the file exists
 * and explicitly contains Traditional Chinese characters.
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const MODES_DIR = join(import.meta.dir, '../../plugin/modes');

describe('code--zh-tw mode file (#1364)', () => {
  it('code--zh-tw.json exists in plugin/modes/', () => {
    const modePath = join(MODES_DIR, 'code--zh-tw.json');
    expect(existsSync(modePath)).toBe(true);
  });

  it('contains Traditional Chinese characters (not only Simplified)', () => {
    const modePath = join(MODES_DIR, 'code--zh-tw.json');
    const content = readFileSync(modePath, 'utf-8');

    // Traditional Chinese characters that differ from Simplified
    // 設 (vs 设), 檔 (vs 档), 開 (vs 开), 為 (vs 为)
    expect(content).toContain('設');
    expect(content).toContain('檔');
    expect(content).toContain('開');
  });

  it('explicitly mentions 繁體中文 in language requirements', () => {
    const modePath = join(MODES_DIR, 'code--zh-tw.json');
    const content = readFileSync(modePath, 'utf-8');

    // Must explicitly request Traditional Chinese, not just 中文
    expect(content).toContain('繁體中文');
  });

  it('is valid JSON with required prompt keys', () => {
    const modePath = join(MODES_DIR, 'code--zh-tw.json');
    const content = readFileSync(modePath, 'utf-8');
    const parsed = JSON.parse(content);

    expect(parsed.name).toBeDefined();
    expect(parsed.prompts).toBeDefined();
    expect(parsed.prompts.footer).toBeDefined();
    expect(parsed.prompts.xml_title_placeholder).toBeDefined();
    expect(parsed.prompts.xml_narrative_placeholder).toBeDefined();
    expect(parsed.prompts.continuation_instruction).toBeDefined();
    expect(parsed.prompts.summary_footer).toBeDefined();
  });
});
