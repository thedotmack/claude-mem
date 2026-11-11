import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { parseAgentXml } from '../../src/sdk/parser.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { hasUnfinishedObservationBlock } from '../../src/services/worker/agents/ResponseProcessor.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const state = ModeManager.getInstance() as unknown as { activeMode: unknown; activeModeId: unknown };
let previousMode: unknown;
let previousModeId: unknown;
beforeEach(() => {
  previousMode = state.activeMode;
  previousModeId = state.activeModeId;
  ModeManager.getInstance().loadMode('code');
});
afterEach(() => { state.activeMode = previousMode; state.activeModeId = previousModeId; });

describe('observer XML literal markup', () => {
  it('retains a whole observation when its narrative documents a closing observation tag', () => {
    const narrative = '<![CDATA[Before </observation> <title>example</title> after]]>';
    const parsed = parseAgentXml(`<observation><type>discovery</type><title>Parser behavior</title><narrative>${narrative}</narrative><facts><fact>The text continues.</fact></facts></observation>`);
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) throw new Error('Expected observation');
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.observations[0]).toMatchObject({ title: 'Parser behavior', narrative, facts: ['The text continues.'] });
    const store = new SessionStore(':memory:');
    try {
      const session = store.getOrCreateManualSession('literal-markup');
      const { id } = store.storeObservation(session, 'literal-markup', parsed.observations[0], 1);
      expect(store.getObservationById(id)).toMatchObject({ narrative, facts: JSON.stringify(['The text continues.']) });
    } finally { store.close(); }
  });

  it('retains summary fields that document their own closing tags', () => {
    const learned = '<![CDATA[Do not end at </learned> or </summary>.]]>';
    const parsed = parseAgentXml(`<summary><request>Explain the parser</request><learned>${learned}</learned><completed>Documented</completed></summary>`);
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) throw new Error('Expected summary');
    expect(parsed.summary).toMatchObject({ learned, completed: 'Documented' });
  });

  it('keeps literal array closers inside their original fact', () => {
    const fact = '<![CDATA[Keep </fact> and </facts> literal.]]>';
    const parsed = parseAgentXml(`<observation><type>discovery</type><title>Fact syntax</title><facts><fact>${fact}</fact><fact>Another fact</fact></facts></observation>`);
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) throw new Error('Expected observation');
    expect(parsed.observations[0].facts).toEqual([fact, 'Another fact']);
  });

  it('ignores commented document and field examples when choosing actual content', () => {
    const parsed = parseAgentXml('<!-- <summary><request>Example only</request></summary> --><observation><type>discovery</type><!-- <title>Old title</title> --><title>Actual title</title></observation>');
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) throw new Error('Expected observation');
    expect(parsed.summary).toBeNull();
    expect(parsed.observations.map(row => row.title)).toEqual(['Actual title']);
  });

  it('does not let a literal closing tag complete an unfinished observation', () => {
    const raw = '<observation><title>X</title><narrative><![CDATA[Literal </observation>]]>';
    expect(parseAgentXml(raw)).toEqual({ valid: false });
    expect(hasUnfinishedObservationBlock(raw)).toBe(true);
  });

  it('keeps an observation whose text mentions an unterminated comment or CDATA opener', () => {
    const narrative = 'Parser now skips <!-- markers in templates.';
    const raw = `<observation><type>discovery</type><title>HTML comments</title><narrative>${narrative}</narrative><facts><fact>Also <![CDATA[ openers</fact></facts></observation>`;
    const parsed = parseAgentXml(raw);
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) throw new Error('Expected observation');
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.observations[0]).toMatchObject({ title: 'HTML comments', narrative });
    expect(parsed.observations[0].facts).toEqual(['Also <![CDATA[ openers']);
    expect(hasUnfinishedObservationBlock(raw)).toBe(false);
  });
  it('keeps separate observations when a bare opener precedes a later comment', () => {
    const first = 'Parser skips <!-- markers in templates.';
    const second = 'Keep <!-- example --> in documentation.';
    const raw = '<observation><type>discovery</type><title>First</title>' +
      `<narrative>${first}</narrative><facts><fact>First fact</fact></facts></observation>` +
      '<observation><type>bugfix</type><title>Second</title>' +
      `<narrative>${second}</narrative><facts><fact>Second fact</fact></facts></observation>`;
    const parsed = parseAgentXml(raw);
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) throw new Error('Expected observations');
    expect(parsed.observations.map(row => ({
      type: row.type, title: row.title, narrative: row.narrative, facts: row.facts,
    }))).toEqual([
      { type: 'discovery', title: 'First', narrative: first, facts: ['First fact'] },
      { type: 'bugfix', title: 'Second', narrative: second, facts: ['Second fact'] },
    ]);
    expect(hasUnfinishedObservationBlock(raw)).toBe(false);
    const store = new SessionStore(':memory:');
    try {
      const session = store.getOrCreateManualSession('comment-boundaries');
      const stored = parsed.observations.map(row => {
        const { id } = store.storeObservation(session, 'comment-boundaries', row, 1);
        return store.getObservationById(id);
      });
      expect(stored.map(row => [row?.title, row?.narrative, row?.facts])).toEqual([
        ['First', first, JSON.stringify(['First fact'])],
        ['Second', second, JSON.stringify(['Second fact'])],
      ]);
    } finally { store.close(); }
  });

  it('preserves valid comment and CDATA boundaries across separate records', () => {
    const first = '<![CDATA[Before <!-- opener and </observation> <observation> after]]>';
    const second = '<!-- Example </observation> <observation> --> actual text';
    const raw = '<!-- <observation><title>Example only</title></observation> -->' +
      `<observation><title>First</title><narrative>${first}</narrative></observation>` +
      `<observation><title>Second</title><narrative>${second}</narrative></observation>`;
    const parsed = parseAgentXml(raw);
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) throw new Error('Expected observations');
    expect(parsed.observations.map(row => [row.title, row.narrative])).toEqual([
      ['First', first], ['Second', second],
    ]);
    expect(hasUnfinishedObservationBlock(raw)).toBe(false);
  });

  it('does not let a later comment close an unfinished second record', () => {
    const raw = '<observation><title>First</title><narrative>Skips <!-- markers</narrative></observation>' +
      '<observation><title>Second</title><narrative><!-- example </observation> --></narrative>';
    const parsed = parseAgentXml(raw);
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) throw new Error('Expected completed first observation');
    expect(parsed.observations.map(row => [row.title, row.narrative])).toEqual([
      ['First', 'Skips <!-- markers'],
    ]);
    expect(hasUnfinishedObservationBlock(raw)).toBe(true);
  });

});
