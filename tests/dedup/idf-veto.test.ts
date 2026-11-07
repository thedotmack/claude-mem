import { describe, it, expect } from 'bun:test';
import { vetoFires } from '../../src/services/dedup/idfVeto.js';
import { buildIdfFn, idf } from '../../src/services/dedup/idf.js';
import { tokenizeWs } from '../../src/services/dedup/normalize.js';

const N = 1000;
const DF = new Map<string, number>([
  // common (low idf) — never discriminating
  ['added', 500], ['dependency', 300], ['to', 900], ['crate', 200], ['versions', 400],
  ['review', 400], ['approval', 150], ['for', 900], ['in', 900], ['pinned', 250],
  ['code', 250], ['security', 180], // common words that happen to be discriminating IN CONTEXT
  // rare (high idf) — discriminating identifiers
  ['rdlp-api', 3], ['rdlp-plugin', 3], ['ffmpeg-7.1.conf', 1], ['ffmpeg-6.1.conf', 1],
  ['countycode', 4], ['municipalitynumber', 4],
]);
const idfFn = buildIdfFn((t) => DF.get(t) ?? 0, N);
const THETA = idf(10, N); // "token in <= ~10 records is discriminating"
const veto = (a: string, b: string) => vetoFires(tokenizeWs(a), tokenizeWs(b), idfFn, THETA);

describe('vetoFires', () => {
  it('fires when the difference is a rare identifier (rdlp-api vs rdlp-plugin)', () => {
    expect(veto('Added dependency to rdlp-api crate', 'Added dependency to rdlp-plugin crate')).toBe(true);
  });

  it('fires when the difference is a rare version token (ffmpeg-7.1 vs 6.1)', () => {
    expect(veto('Pinned versions in ffmpeg-7.1.conf', 'Pinned versions in ffmpeg-6.1.conf')).toBe(true);
  });

  it('fires on distinct rare value-objects (CountyCode vs MunicipalityNumber)', () => {
    expect(veto('CountyCode record value object', 'MunicipalityNumber record value object')).toBe(true);
  });

  it('does NOT fire for a pure word-reorder (empty symmetric difference)', () => {
    expect(veto('added dependency crate', 'crate added dependency')).toBe(false);
  });

  it('does NOT fire when sides are identical', () => {
    expect(veto('added rdlp-api crate', 'added rdlp-api crate')).toBe(false);
  });

  it('KNOWN LIMITATION: does NOT fire when the discriminator is a COMMON token (code vs security)', () => {
    // "code"/"security" are common (low idf) yet here they ARE the distinction.
    // Lexical methods cannot catch this — it is precisely the residual that the
    // Branch-2 LLM-adjudication tier is designed to handle. Documented, not a bug.
    expect(veto('Code review approval for archive', 'Security review approval for archive')).toBe(false);
  });
});
