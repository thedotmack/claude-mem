import { describe, it, expect } from 'bun:test';
import {
  buildAnnotationPrompt,
  parseAnnotationResponse,
  type AnnotationCandidate,
} from '../../../src/services/worker/RelevanceAnnotator.js';

const CANDIDATES: AnnotationCandidate[] = [
  { key: 'id:1', title: 'Fixed token refresh race', narrative: 'The refresh mutex was released too early', project: 'kit' },
  { key: 'id:2', title: 'Chroma collection naming', narrative: 'Collections are prefixed cm__ per project' },
  { key: 'id:3', title: 'No narrative observation' },
];

describe('buildAnnotationPrompt', () => {
  it('numbers candidates and embeds the query', () => {
    const prompt = buildAnnotationPrompt('why does refresh flake?', CANDIDATES);
    expect(prompt).toContain('why does refresh flake?');
    expect(prompt).toContain('1. Fixed token refresh race [from project: kit]');
    expect(prompt).toContain('2. Chroma collection naming');
    expect(prompt).toContain('3. No narrative observation');
    expect(prompt).toContain('"verdict": "drop"');
    // Hint grammar: factual link to the request, never a directive addressed
    // at the consuming agent ("say…", "use this to…", "report…").
    expect(prompt).toContain('relevant because');
    expect(prompt).toContain('no directives');
  });

  it('names the current project and raises the bar for foreign candidates', () => {
    const foreign: AnnotationCandidate[] = [
      { key: 'id:5', title: 'Local note', narrative: 'n', project: 'kit' },
      { key: 'id:6', title: 'Foreign note', narrative: 'n', project: 'search' },
    ];
    const prompt = buildAnnotationPrompt('q', foreign, 'kit');
    expect(prompt).toContain('CURRENT PROJECT: kit');
    // Same-project candidate is NOT tagged; the foreign one is.
    expect(prompt).toContain('1. Local note\n');
    expect(prompt).toContain('2. Foreign note [from project: search]');
    expect(prompt).toContain('a merely similarly-worded request is NOT');
    expect(prompt).toContain('Never claim the projects are the same');
  });

  it('truncates narratives to bound per-prompt input tokens', () => {
    const long: AnnotationCandidate[] = [
      { key: 'id:9', title: 'LONG', narrative: 'x'.repeat(1000) },
    ];
    const prompt = buildAnnotationPrompt('q', long);
    expect(prompt).not.toContain('x'.repeat(1000));
    expect(prompt).toContain('x'.repeat(300));
  });
});

describe('parseAnnotationResponse', () => {
  it('parses a clean JSON array into verdicts keyed by candidate key', () => {
    const text = '[{"i":1,"verdict":"keep","hint":"same race as your bug"},{"i":2,"verdict":"drop"}]';
    const verdicts = parseAnnotationResponse(text, CANDIDATES, true)!;
    expect(verdicts).not.toBeNull();
    expect(verdicts.get('id:1')).toEqual({ hint: 'same race as your bug' });
    expect(verdicts.get('id:2')).toBe('drop');
    expect(verdicts.has('id:3')).toBe(false); // no entry → no verdict
  });

  it('tolerates markdown fences and surrounding prose', () => {
    const text = 'Here are the verdicts:\n```json\n[{"i":1,"verdict":"keep","hint":"h"}]\n```\nDone.';
    const verdicts = parseAnnotationResponse(text, CANDIDATES, true)!;
    expect(verdicts.get('id:1')).toEqual({ hint: 'h' });
  });

  it('returns null on unparseable output (fail-open signal)', () => {
    expect(parseAnnotationResponse('I cannot help with that.', CANDIDATES, true)).toBeNull();
    expect(parseAnnotationResponse('[{broken json', CANDIDATES, true)).toBeNull();
    expect(parseAnnotationResponse('{"i":1}', CANDIDATES, true)).toBeNull();
  });

  it('drops are omitted entirely when allowDrop is false', () => {
    const text = '[{"i":1,"verdict":"drop"},{"i":2,"verdict":"keep","hint":"h"}]';
    const verdicts = parseAnnotationResponse(text, CANDIDATES, false)!;
    expect(verdicts.has('id:1')).toBe(false);
    expect(verdicts.get('id:2')).toEqual({ hint: 'h' });
  });

  it('truncates over-long hints and skips out-of-range indexes', () => {
    const text = JSON.stringify([
      { i: 1, verdict: 'keep', hint: 'y'.repeat(300) },
      { i: 99, verdict: 'keep', hint: 'ghost' },
      { i: 'x', verdict: 'keep', hint: 'no index' },
      { i: 2, verdict: 'keep' }, // missing hint → skipped
    ]);
    const verdicts = parseAnnotationResponse(text, CANDIDATES, true)!;
    expect((verdicts.get('id:1') as { hint: string }).hint.length).toBe(140);
    expect(verdicts.has('id:2')).toBe(false);
    expect(verdicts.size).toBe(1);
  });
});
