import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanOwnerPrompts } from '../../../src/services/prompt-import/index.js';
import { AgentTextIndex, isAgentWritten, normalize, provenanceFingerprint } from '../../../src/services/prompt-import/owner-prompt-filter.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { resolvePythonCommand } from '../../../src/services/work-view/python.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const LANGUAGES = [
  ['Chinese', '请检查项目中的数据保存流程，修复实际发现的问题，保留原始记录并验证重新导入不会产生重复内容。请说明具体修改和测试结果，不能把尚未完成的工作描述为完成。'.repeat(4)],
  ['Japanese', '履歴の読み込み処理を確認し、実際に発見した問題を修正してください。元の記録を保持し、再読み込みで重複が発生しないことを検証して、変更内容と結果を説明してください。'.repeat(4)],
  ['Arabic', 'يرجى مراجعة طريقة حفظ البيانات وتصحيح المشكلة مع الاحتفاظ بالسجلات الأصلية والتحقق من أن الاستيراد المتكرر لا يضيف نسخا مكررة ثم توضيح التغييرات ونتائج الاختبارات. '.repeat(3).trim()],
  ['Cyrillic', 'Проверьте обработку истории и исправьте найденную ошибку, сохраняя исходные записи. Убедитесь, что повторный импорт не создает дубликатов, и опишите изменения и результаты проверки. '.repeat(3).trim()],
  ['supplementary letters', '𠮷野家の記録を確認して履歴を保持し、同じ依頼を再び読み込んでも重複しないことを検証してください。'.repeat(5)],
] as const;

async function imported(agentText: string, promptText: string, expectedAuthored: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'cmem-unicode-provenance-'));
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  try {
    const folder = join(home, '.claude', 'projects', 'example');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'session.jsonl'), [
      { type: 'assistant', timestamp: new Date(NOW - 10_000).toISOString(), message: { content: [{ type: 'text', text: `𠮷: ${agentText}` }] } },
      { type: 'user', uuid: 'user-native', sessionId: 'session', timestamp: new Date(NOW).toISOString(), cwd: '/projects/example',
        origin: { kind: 'human' }, entrypoint: 'cli', message: { role: 'user', content: promptText } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const options = { homeDirectory: home, agents: ['claude-code'] as const, sinceEpochMs: NOW - 30 * 86400000,
      excludedProjects: '', resolveProject: () => 'example' };
    const scanOptions = { ...options, agents: [...options.agents] };
    const result = await scanOwnerPrompts({ ...scanOptions, memoryPrompts: [{ id: 41, platformSource: 'claude', contentSessionId: 'hook-session', promptText, createdAtEpoch: NOW }] });
    const scanner = new SetupScan({ getStore: () => store, now: () => NOW, scanOptions });
    scanner.start();
    const status = await scanner.finished();
    expect({ owner: result.ownerPrompts.map(prompt => prompt.text), written: result.agentWritten.map(prompt => prompt.text),
      memory: [...result.ownerMemoryPromptIds], added: status.added, rows: store.db.query('SELECT prompt_text FROM user_prompts').all() })
      .toEqual(expectedAuthored ? { owner: [], written: [promptText], memory: [], added: 0, rows: [] }
        : { owner: [promptText], written: [], memory: [41], added: 1, rows: [{ prompt_text: promptText }] });
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
}

describe('Unicode owner-prompt provenance', () => {
  for (const [language, text] of LANGUAGES) {
    it(`excludes ${language} instructions authored earlier by an agent from setup import`, () => imported(text, text, true));
  }

  it('keeps a different Chinese instruction ahead of the same pasted English material', async () => {
    const reference = 'The reference document describes the storage architecture and existing behavior. Preserve the records, explain the outcome, and list the verification steps with enough detail to reproduce the reported issue. '.repeat(2).trim();
    await imported(`请修改代码并立即发布。${reference}`, `请只检查问题不要修改。${reference}`, false);
  });

  it('counts supplementary letters as characters at the minimum-length boundary', () => {
    const short = '𠀀'.repeat(159), long = '𠀀'.repeat(160);
    expect(provenanceFingerprint(short)).toBeNull();
    const fingerprint = provenanceFingerprint(long);
    expect(fingerprint).toBe('𠀀'.repeat(120));
    const index = new AgentTextIndex([fingerprint!]);
    index.add(90, `𠀁𠀂${long}𠀃`);
    expect(isAgentWritten(100, long, index)).toBe(true);
    expect(isAgentWritten(100, short, index)).toBe(false);
    expect(isAgentWritten(90, long, index)).toBe(false);
    expect(isAgentWritten(89, long, index)).toBe(false);
  });

  it('keeps lowercase openings in BMP and supplementary alphabets', () => {
    for (const prompt of ['please preserve the existing lowercase policy '.repeat(5), 'проверьте сохранение исходных записей '.repeat(7), '𐐨'.repeat(180), 'ʰ'.repeat(180)]) {
      expect(provenanceFingerprint(prompt)).toBeNull();
      expect(isAgentWritten(100, prompt, new AgentTextIndex([]))).toBe(false);
    }
  });

  it('keeps the TypeScript filter and Python skill in agreement', async () => {
    const python = await resolvePythonCommand();
    const texts = [...LANGUAGES.map(([, text]) => text), '𠀀'.repeat(159), '𠀀'.repeat(160), '𐐨'.repeat(180), 'ʰ'.repeat(180),
      'Implement the change, preserve existing behavior and verify the result with recorded evidence before reporting completion. '.repeat(2)];
    const path = join(import.meta.dir, '..', '..', '..', 'plugin', 'skills', 'owner-goals', 'scripts', 'export_owner_prompts.py');
    const result = spawnSync(python.command, [...python.args, '-c', [
      'import json, runpy, sys',
      'skill = runpy.run_path(sys.argv[1])',
      'texts = json.load(sys.stdin)',
      'print(json.dumps([{ "normalized": skill["normalize"](text), "earlier": skill["is_agent_written"](100, text, [(90, skill["normalize"]("𠮷: " + text))]), "same": skill["is_agent_written"](90, text, [(90, skill["normalize"](text))]) } for text in texts]))',
    ].join('\n'), path], { input: JSON.stringify(texts), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const expected = texts.map(text => {
      const fingerprint = provenanceFingerprint(text);
      const index = new AgentTextIndex(fingerprint ? [fingerprint] : []);
      index.add(90, `𠮷: ${text}`);
      return { normalized: normalize(text), earlier: isAgentWritten(100, text, index), same: isAgentWritten(90, text, index) };
    });
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(expected.map(row => row.earlier)).toEqual([true, true, true, true, true, false, true, false, false, true]);
  });
});
