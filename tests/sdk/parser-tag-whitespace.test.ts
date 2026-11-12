import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { parseAgentXml } from '../../src/sdk/parser.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { hasUnfinishedObservationBlock } from '../../src/services/worker/agents/ResponseProcessor.js';

const modeState = ModeManager.getInstance() as unknown as { activeMode: unknown; activeModeId: unknown };
let previousMode: unknown;
let previousModeId: unknown;
beforeEach(() => {
  previousMode = modeState.activeMode;
  previousModeId = modeState.activeModeId;
  ModeManager.getInstance().loadMode('code');
});
afterEach(() => {
  modeState.activeMode = previousMode;
  modeState.activeModeId = previousModeId;
});

const observation = '<observation><type>bugfix</type><title>Retain the result</title><subtitle>Schema whitespace</subtitle><narrative>A complete explanation.</narrative><facts><fact>One &amp; two</fact></facts><concepts><concept>how-it-works</concept></concepts><files_read><file>src/input.ts</file></files_read><files_modified><file>src/output.ts</file></files_modified></observation>';
const padded = (raw: string, space: string, side: 'open' | 'close' | 'both') => raw.replace(/<(\/?)([a-z_]+)>/g,
  (tag, close, name) => side === 'both' || Boolean(close) === (side === 'close') ? `<${close}${name}${space}>` : tag);

describe('XML whitespace before a tag delimiter', () => {
  for (const space of [' ', '\t', '\r', '\n', ' \t\r\n']) {
    for (const side of ['open', 'close', 'both'] as const) {
      it(`retains complete observations with ${JSON.stringify(space)} in ${side} tags`, () => {
        expect(parseAgentXml(padded(observation, space, side))).toEqual(parseAgentXml(observation));
      });
    }

    it(`retains summaries and notes with ${JSON.stringify(space)} in tags`, () => {
      const summary = '<summary><request>Fix parsing</request><investigated>Tag syntax</investigated><learned>Use XML whitespace</learned><completed>Corrected</completed><next_steps>Ship</next_steps><notes>Keep details &amp; examples</notes></summary>';
      expect(parseAgentXml(padded(summary, space, 'both'))).toEqual(parseAgentXml(summary));
    });

    it(`distinguishes a complete reply from a cut tail with ${JSON.stringify(space)}`, () => {
      expect(hasUnfinishedObservationBlock(padded(observation, space, 'both'))).toBe(false);
      expect(hasUnfinishedObservationBlock(observation + `<observation${space}><title>Unfinished`)).toBe(true);
    });
  }

  it('preserves the final restarted type and the stray-closer fallback', () => {
    const restarted = parseAgentXml('<observation ><type >bugfix</parameter > <type\t>discovery</type\n><title >Actual title</title ></observation >');
    expect(restarted.valid).toBe(true);
    if (!restarted.valid) throw new Error('Expected complete observation');
    expect(restarted.observations[0].type).toBe('discovery');
    const stray = parseAgentXml('<observation ><type >bugfix</parameter ><title >Actual title</title ></observation >');
    expect(stray.valid).toBe(true);
    if (!stray.valid) throw new Error('Expected complete observation');
    expect(stray.observations[0].type).toBe('bugfix');
  });

  it('keeps padded closing tags in CDATA literal and persists all fields', () => {
    const narrative = '<![CDATA[Literal </observation > and </narrative\n> stay inside the note.]]>';
    const raw = `<observation ><type >discovery</type ><title >Delimiter examples</title ><narrative >${narrative}</narrative ><facts ><fact >A &amp; B</fact ></facts ></observation >`;
    const parsed = parseAgentXml(raw);
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) throw new Error('Expected complete observation');
    expect(parsed.observations).toHaveLength(1);
    expect(hasUnfinishedObservationBlock(raw)).toBe(false);
    const store = new SessionStore(':memory:');
    try {
      const session = store.getOrCreateManualSession('tag-whitespace');
      const { id } = store.storeObservation(session, 'tag-whitespace', parsed.observations[0], 1);
      expect(store.getObservationById(id)).toMatchObject({ title: 'Delimiter examples', narrative, facts: JSON.stringify(['A & B']) });
    } finally { store.close(); }
  });

  it('does not salvage type-only records as content', () => {
    expect(parseAgentXml('<observation ><type >bugfix</type ></observation >')).toEqual({ valid: false });
  });

  it('does not treat a commented padded closing tag as completion', () => {
    const raw = '<observation ><title >Incomplete</title ><!-- </observation > -->';
    expect(parseAgentXml(raw)).toEqual({ valid: false });
    expect(hasUnfinishedObservationBlock(raw)).toBe(true);
  });

  it('keeps the attachment label and no-attribute contracts', () => {
    const parsed = parseAgentXml('<observation ><type >discovery</type ><title >Image</title ><attachments><attachment>event1_image1</attachment></attachments><ATTACHMENTS><attachment>event2_image1</attachment></ATTACHMENTS></observation >');
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) throw new Error('Expected complete observation');
    expect(parsed.observations[0].attachments).toEqual(['event1_image1']);
    expect(parseAgentXml('<observation id="x"><title>Unsupported attributes</title></observation>')).toEqual({ valid: false });
  });

  for (const invalid of ['\u00a0', '\v', '\f', '\u2028']) {
    it(`does not extend XML tag whitespace to ${JSON.stringify(invalid)}`, () => {
      expect(parseAgentXml(padded(observation, invalid, 'both'))).toEqual({ valid: false });
    });
  }
});
