import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import ts from 'typescript-compiler-api';
import { DEFAULT_SETTINGS } from '../../src/ui/viewer/constants/settings';
import { PREVIEW_SHORTENINGS, previewTruncationNote, type PreviewShortening } from '../../src/ui/context-preview-note';
import { viewerZh } from '../../src/ui/i18n/viewer-zh';
import { viewerKo } from '../../src/ui/i18n/viewer-ko';
import { viewerFr } from '../../src/ui/i18n/viewer-fr';
import { settingsZh } from '../../src/ui/i18n/settings-zh';
import { settingsKo } from '../../src/ui/i18n/settings-ko';
import { settingsFr } from '../../src/ui/i18n/settings-fr';
import type { Settings } from '../../src/ui/viewer/types';
import {
  SETTINGS_FOOTER_STATES, SETTING_RANGES, changedSettingKeys, outOfRange, settingsFooterState,
} from '../../src/ui/viewer/utils/settings-form';
import { previewFacts } from '../../src/ui/viewer/utils/settings-preview';

const REPO = join(import.meta.dir, '../..');
const ESC = '\x1b';
/** One observation row as the worker writes it (HumanFormatter.renderHumanTableRow). */
const row = (id: number, title: string) => `  ${ESC}[2m#${id}${ESC}[0m  ${ESC}[2m5:21 PM${ESC}[0m  🔵  ${title} `;
/** The note as the worker writes it (ContextBuilder.ts truncateTerminalPreview), from the one definition both share. */
const NOTE = (shortening: PreviewShortening) => `${ESC}[0m\n\n${previewTruncationNote(shortening)}\n`;

describe('the context preview size line and shortened note', () => {
  it('counts what the preview returned exactly: characters without ANSI codes and observation rows', () => {
    const content = [
      `${ESC}[2mAccess Claude-Mem Rules + Tools: ~/.claude-mem/RULES-AND-TOOLS.md${ESC}[0m`, '',
      `${ESC}[1m${ESC}[36mNov 15, 2026${ESC}[0m`, '',
      `${ESC}[2mpackages/cli/src${ESC}[0m`, row(255453, 'CLI groups enumerated'), row(255454, 'Wrappers traced'),
      `${ESC}[33m#S9001${ESC}[0m Finish the release (Nov 15, 5:30 PM)`, '',
    ].join('\n');
    const facts = previewFacts(content);
    expect(facts.observations).toBe(2);
    expect(facts.shortened).toBeNull();
    expect(facts.plainText).not.toContain(ESC);
    expect(facts.characters).toBe([...facts.plainText].length);
    expect(facts.body).toBe(content);
  });

  it('takes the worker\'s shortened note out of the text and says which kind it was', () => {
    const omitted = `head\n${NOTE('observations')}${row(1, 'kept')}\n`;
    const facts = previewFacts(omitted);
    expect(facts.shortened).toBe('observations');
    expect(facts.plainText).not.toContain('Terminal preview truncated');
    expect(facts.observations).toBe(1);
    expect(previewFacts(`${NOTE('text')}tail`).shortened).toBe('text');
    for (const shortening of PREVIEW_SHORTENINGS) expect(previewFacts(`a\n${NOTE(shortening)}b`).shortened).toBe(shortening);
  });

  it('leaves a note in other words where it stands, never dropping it', () => {
    const reworded = `head\n${ESC}[0m\n\n[Terminal preview truncated. Some of this preview is left out.]\n${row(1, 'kept')}\n`;
    const facts = previewFacts(reworded);
    expect(facts.shortened).toBeNull();
    expect(facts.body).toBe(reworded);
    expect(facts.plainText).toContain('[Terminal preview truncated. Some of this preview is left out.]');
  });

  it('reads the note by the same definition the worker writes it with', () => {
    // The sentence is typed once, in src/ui/context-preview-note.ts; the worker builds its note from it.
    const builder = readFileSync(join(REPO, 'src/services/context/ContextBuilder.ts'), 'utf-8');
    expect(builder).toContain("from '../../ui/context-preview-note.js'");
    expect(builder).toContain('previewTruncationNote(');
    expect(builder).not.toContain('Terminal preview truncated');
    expect(builder).not.toContain('are not shown here');
    const parser = readFileSync(join(REPO, 'src/ui/viewer/utils/settings-preview.ts'), 'utf-8');
    expect(parser).not.toContain('Terminal preview truncated');
  });
});

describe('the settings footer', () => {
  const base = { isLoaded: true, loadError: null, isSaving: false, changedCount: 0, savedAt: null };
  it('names one state for each situation, from the one writer, and every state it defines is reached', () => {
    const situations = [
      { ...base, isLoaded: false },
      { ...base, isLoaded: false, loadError: 'HTTP 500' },
      base,
      { ...base, changedCount: 2 },
      { ...base, changedCount: 2, isSaving: true },
      { ...base, savedAt: 1 },
      { ...base, savedAt: 1, changedCount: 1 },
    ];
    expect(situations.map(settingsFooterState)).toEqual(['loading', 'load-failed', 'clean', 'dirty', 'saving', 'saved', 'dirty']);
    // The list comes from the definition, so a state added to it and never reached fails here.
    expect(new Set(situations.map(settingsFooterState))).toEqual(new Set(SETTINGS_FOOTER_STATES));
  });

  it('counts a change only while the form differs from what is saved, and never the file-only CLI path', () => {
    const saved = { ...DEFAULT_SETTINGS } as Settings;
    expect(changedSettingKeys({ ...saved }, saved)).toEqual([]);
    expect(changedSettingKeys({ ...saved, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '80', CLAUDE_MEM_MODEL: 'opus' }, saved))
      .toEqual(['CLAUDE_MEM_CONTEXT_OBSERVATIONS', 'CLAUDE_MEM_MODEL']);
    expect(changedSettingKeys({ ...saved, CLAUDE_CODE_PATH: '/usr/local/bin/claude' }, saved)).toEqual([]);
  });
});

describe('number fields', () => {
  it('refuse what the worker refuses: outside the range, not a number, or a fraction where only whole numbers go', () => {
    expect(outOfRange('0', 'CLAUDE_MEM_CONTEXT_SESSION_COUNT')).toBe(false); // the owner's saved value
    expect(outOfRange('51', 'CLAUDE_MEM_CONTEXT_SESSION_COUNT')).toBe(true);
    expect(outOfRange('', 'CLAUDE_MEM_BACKUP_RETAIN_COUNT')).toBe(true);
    expect(outOfRange('7.5', 'CLAUDE_MEM_BACKUP_RETAIN_COUNT')).toBe(true);
    expect(outOfRange('1.5', 'CLAUDE_MEM_BACKUP_INTERVAL_HOURS')).toBe(false);
    expect(outOfRange('0.5', 'CLAUDE_MEM_BACKUP_INTERVAL_HOURS')).toBe(true);
    expect(outOfRange('1023', 'CLAUDE_MEM_WORKER_PORT')).toBe(true);
  });

  it('say their bounds in the help from SETTING_RANGES, never typed again', () => {
    const modal = readFileSync(join(REPO, 'src/ui/viewer/components/ContextSettingsModal.tsx'), 'utf-8');
    // A range like "(0-200)" typed in a help text would drift from the bounds the field checks.
    expect(modal.match(/t\((['"])[^'"]*\(\d+\s*[-–]\s*\d+\)[^'"]*\1\)/g) ?? []).toEqual([]);
    expect((modal.match(/\(\{min\}-\{max\}\)/g) ?? []).length).toBe(5);
    for (const catalog of [settingsZh, settingsKo, settingsFr]) {
      expect(Object.keys(catalog).filter(key => /\(\d+\s*[-–]\s*\d+\)/.test(key))).toEqual([]);
    }
  });

  it('use the same bounds as the worker\'s settings validation', () => {
    const routes = readFileSync(join(REPO, 'src/services/worker/http/routes/SettingsRoutes.ts'), 'utf-8');
    for (const [key, { min, max }] of Object.entries(SETTING_RANGES)) {
      expect(routes).toContain(`${key} must be between ${min} and ${max}`);
    }
  });
});

describe('model policy (CLAUDE.md): no dated Claude model id in front of people', () => {
  // e.g. claude-haiku-4-5-20251001 or claude-3-5-haiku-20241022: a tier name and an eight-digit date.
  const DATED_MODEL_ID = /claude-(?:[a-z]+-)?(?:\d+-)*(?:haiku|sonnet|opus)(?:-\d+)*-\d{8}\b/;
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
  it('appears nowhere in the viewer source or the viewer and settings catalogs', () => {
    const scanned = [
      ...files(join(REPO, 'src/ui/viewer')),
      ...['viewer', 'settings'].flatMap(catalog => ['zh', 'ko', 'fr'].map(locale => join(REPO, `src/ui/i18n/${catalog}-${locale}.ts`))),
    ];
    expect(scanned.length).toBeGreaterThan(20);
    const offenders = scanned.filter(path => DATED_MODEL_ID.test(readFileSync(path, 'utf-8')));
    expect(offenders).toEqual([]);
    expect(DATED_MODEL_ID.test('e.g., claude-haiku-4-5-20251001')).toBe(true);
  });
});

describe('the preview\'s ANSI palette is the theme', () => {
  const template = readFileSync(join(REPO, 'src/ui/viewer-template.html'), 'utf-8');
  const tokens = (opener: string): Record<string, string> => {
    const start = template.indexOf(opener);
    const body = template.slice(start + opener.length, template.indexOf('}', start));
    return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
  };
  const luminance = (hex: string) => {
    const channels = [0, 2, 4].map(offset => parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255)
      .map(channel => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (a: string, b: string) => {
    const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (lighter + 0.05) / (darker + 0.05);
  };
  const source = readFileSync(join(REPO, 'src/ui/viewer/components/TerminalPreview.tsx'), 'utf-8');
  const palette = [...new Set([...source.matchAll(/var\((--[\w-]+)\)/g)].map(match => match[1]))];

  it('draws every ANSI colour with a token that reads at 4.5:1 on the preview well in both themes', () => {
    expect(palette.length).toBeGreaterThan(5);
    expect(source).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    for (const opener of ['[data-theme="light"] {', '[data-theme="dark"] {']) {
      const theme = tokens(opener);
      const well = theme['--color-bg-primary'];
      for (const token of palette.filter(name => name !== '--color-bg-primary')) {
        expect({ opener, token, defined: token in theme }).toEqual({ opener, token, defined: true });
        expect({ opener, token, ok: contrast(theme[token], well) >= 4.5 }).toEqual({ opener, token, ok: true });
      }
    }
  });
});

describe('the Settings dialog\'s words are in Track B\'s own catalogs', () => {
  /** Every literal t('…') key in a file (as tests/ui-i18n.test.ts finds them). */
  const literalKeys = (path: string): string[] => {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf-8'), ts.ScriptTarget.Latest, true);
    const keys: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
        keys.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return keys;
  };
  const files = ['src/ui/viewer/components/ContextSettingsModal.tsx', 'src/ui/viewer/components/TerminalPreview.tsx'];

  it('has an entry for every word in the viewer or settings catalog of each language, not only in My Work\'s', () => {
    const keys = [...new Set(files.flatMap(file => literalKeys(join(REPO, file))))];
    expect(keys.length).toBeGreaterThan(100);
    for (const [name, catalog] of [['zh', { ...viewerZh, ...settingsZh }], ['ko', { ...viewerKo, ...settingsKo }], ['fr', { ...viewerFr, ...settingsFr }]] as const) {
      expect({ name, missing: keys.filter(key => !(key in catalog)) }).toEqual({ name, missing: [] });
    }
  });
});
