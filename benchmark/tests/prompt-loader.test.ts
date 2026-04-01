import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadPrompts } from '../src/prompt-loader.js';

const PROMPTS_DIR = join(import.meta.dir, '..', 'prompts');

describe('prompt-loader', () => {
  test('loads all 20 prompts from prompts directory', async () => {
    const prompts = await loadPrompts(PROMPTS_DIR);
    expect(prompts.length).toBe(20);
  });

  test('each prompt has required frontmatter fields', async () => {
    const prompts = await loadPrompts(PROMPTS_DIR);

    for (const prompt of prompts) {
      const fm = prompt.frontmatter;
      expect(fm.id).toBeString();
      expect(fm.id.length).toBeGreaterThan(0);
      expect(fm.title).toBeString();
      expect(fm.title.length).toBeGreaterThan(0);
      expect(['web', 'cli', 'api', 'data', 'fullstack', 'frontend']).toContain(
        fm.category,
      );
      expect(fm.timeout_hint).toBeString();
      expect(fm.industry_baseline).toBeDefined();
      expect(fm.industry_baseline.source).toBeString();
      expect(fm.smoke_tests).toBeArray();
      expect(fm.smoke_tests.length).toBeGreaterThan(0);

      for (const smokeTest of fm.smoke_tests) {
        expect(smokeTest.name).toBeString();
        expect(smokeTest.command).toBeString();
        expect(smokeTest.expected).toBeString();
      }
    }
  });

  test('prompts are sorted by id', async () => {
    const prompts = await loadPrompts(PROMPTS_DIR);
    const ids = prompts.map((p) => p.frontmatter.id);
    const sortedIds = [...ids].sort();
    expect(ids).toEqual(sortedIds);
  });

  test('each prompt has a non-empty body', async () => {
    const prompts = await loadPrompts(PROMPTS_DIR);

    for (const prompt of prompts) {
      expect(prompt.body.length).toBeGreaterThan(0);
      expect(prompt.filePath).toContain('.md');
    }
  });

  test('all prompt IDs are unique', async () => {
    const prompts = await loadPrompts(PROMPTS_DIR);
    const ids = prompts.map((p) => p.frontmatter.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
