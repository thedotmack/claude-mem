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

  it('does not let an unfinished CDATA section close the observation', () => {
    const raw = '<observation><title>Unfinished</title><narrative><![CDATA[Literal </observation>';
    expect(parseAgentXml(raw)).toEqual({ valid: false });
    expect(hasUnfinishedObservationBlock(raw)).toBe(true);
  });
});
