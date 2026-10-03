// Phase 4 parser and linkage contracts: parser-outcomes.json through the real
// parser plus linkAttachmentRefs, and manifest-merge.json through
// mergeMediaManifest.
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseAgentXml } from '../../src/sdk/parser.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { linkAttachmentRefs, imageTurnContent, turnImageInstruction } from '../../src/services/media/inference.js';
import { mergeMediaManifest } from '../../src/services/media/linkage.js';
import { MediaError } from '../../src/shared/media-contract.js';

const read = (name: string) => readFileSync(new URL(`../fixtures/media-v1/inference/${name}`, import.meta.url), 'utf8');
const parserOutcomes = JSON.parse(read('parser-outcomes.json'));
const manifestMerge = JSON.parse(read('manifest-merge.json'));
const twoImageRequest = JSON.parse(read('request-two-images.json'));

let modeSpy: ReturnType<typeof spyOn>;
beforeAll(() => {
  modeSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
    getActiveMode: () => ({ observation_types: [{ id: 'discovery' }, { id: 'change' }], observation_concepts: [] }),
  }) as never);
});
afterAll(() => modeSpy.mockRestore());

describe('parser-outcomes.json', () => {
  for (const parserCase of parserOutcomes.cases) {
    it(parserCase.name, () => {
      const response = parserCase.response_file ? read(parserCase.response_file) : parserCase.response;
      const parsed = parseAgentXml(response);
      expect(parsed.valid).toBe(parserCase.expected.valid);
      const observations = parsed.valid ? parsed.observations : [];
      const outcome = linkAttachmentRefs(observations, parserCase.supplied);
      expect(outcome.observations).toEqual(parserCase.expected.observations);
      expect(outcome.unassigned).toEqual(parserCase.expected.unassigned);
    });
  }

  it('grammar comes first: wrong case and out-of-range ordinals are invalid_label', () => {
    const supplied = [{ label: 'event1_image1', event: 1 }];
    const outcome = linkAttachmentRefs([{ attachments: ['EVENT1_IMAGE1'] }, { attachments: ['event1_image9'] }], supplied);
    expect(outcome.observations.flatMap(observation => observation.rejected.map(rejection => rejection.reason))).toEqual(['invalid_label', 'invalid_label']);
    expect(outcome.unassigned).toEqual(['event1_image1']);
  });

  it('reads only the first lowercase <attachments> block, case-sensitively', () => {
    const parsed = parseAgentXml('<observation><type>discovery</type><title>t</title>'
      + '<attachments><attachment>event1_image2</attachment></attachments>'
      + '<attachments><attachment>event1_image1</attachment></attachments></observation>');
    expect(parsed.valid && parsed.observations[0].attachments).toEqual(['event1_image2']);
  });

  it('strips <attachments> in the salvage path without counting it as schema drift', () => {
    const parsed = parseAgentXml('<observation>Screenshot shows the login form\n<attachments><attachment>event1_image1</attachment></attachments></observation>');
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) return;
    expect(parsed.schemaDrift).toBeUndefined();
    expect(parsed.observations[0].title).toBe('Screenshot shows the login form');
    expect(parsed.observations[0].narrative).toBeNull();
    expect(parsed.observations[0].attachments).toEqual(['event1_image1']);
  });

  it('bounds the parsed element count and text length', () => {
    const many = Array.from({ length: 40 }, () => `<attachment>${'x'.repeat(500)}</attachment>`).join('');
    const parsed = parseAgentXml(`<observation><type>discovery</type><title>t</title><attachments>${many}</attachments></observation>`);
    if (!parsed.valid) throw new Error('expected valid');
    expect(parsed.observations[0].attachments!.length).toBeLessThanOrEqual(16);
    expect(parsed.observations[0].attachments!.every(label => label.length <= 128)).toBe(true);
  });

  it('observations without the element keep the existing parse shape', () => {
    const parsed = parseAgentXml('<observation><type>discovery</type><title>t</title></observation>');
    if (!parsed.valid) throw new Error('expected valid');
    expect('attachments' in parsed.observations[0]).toBe(false);
  });
});

describe('request content parts (request-two-images.json)', () => {
  it('rebuilds the fixture final user message from the turn string and images', () => {
    const finalMessage = twoImageRequest.body.messages.at(-1);
    const images = finalMessage.content
      .filter((part: { type: string }) => part.type === 'image_url')
      .map((part: { image_url: { url: string } }, index: number) => ({
        requestLabel: twoImageRequest.request_labels[index].request_label,
        dataUrl: part.image_url.url,
      }));
    expect(imageTurnContent(finalMessage.content[0].text, images)).toEqual(finalMessage.content);
    expect(finalMessage.content[1].text).toBe(turnImageInstruction(['event1_image1', 'event1_image2']));
  });
});

describe('manifest-merge.json', () => {
  for (const mergeCase of manifestMerge.cases) {
    it(mergeCase.name, () => {
      if (mergeCase.expected_error) {
        let thrown: unknown;
        try { mergeMediaManifest(mergeCase.existing_metadata, mergeCase.new_refs); } catch (error) { thrown = error; }
        expect(thrown).toBeInstanceOf(MediaError);
        expect((thrown as MediaError).code).toBe(mergeCase.expected_error);
        return;
      }
      const merged = mergeMediaManifest(mergeCase.existing_metadata, mergeCase.new_refs);
      expect(merged.metadata).toEqual(mergeCase.expected_metadata);
      expect(merged.changed).toBe(mergeCase.manifest_changed);
      expect(merged.eventLevel.map(ref => ref.id)).toEqual(mergeCase.expected_event_level ?? []);
    });
  }

  it('keeps overflow true once set, even when a later merge fits nothing new', () => {
    const existing = { cmem_media_v1: { version: 1, attachments: [], overflow: true } };
    const merged = mergeMediaManifest(existing, [{ id: '11111111-1111-4111-8111-111111111111', label: 'event1_image1', inspection: 'inspected' }]);
    expect(merged.manifest.overflow).toBe(true);
  });
});
