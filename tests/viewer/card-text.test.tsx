import { describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PromptCard } from '../../src/ui/viewer/components/PromptCard';
import { observationText } from '../../src/ui/viewer/components/ObservationCard';
import type { Observation, UserPrompt } from '../../src/ui/viewer/types';

const prompt = (id: number, text: string): UserPrompt => ({
  id, content_session_id: 's', project: 'p', platform_source: 'claude', prompt_number: id, prompt_text: text,
  created_at_epoch: Date.UTC(2026, 10, 15, 18, 0, 0) - id * 1000,
});

describe('folded prompt repeats keep what each one said (G1, PR #6229 review)', () => {
  it('shows an earlier time\'s own words when its case or spacing differ, and not again when they are the same', () => {
    const html = renderToStaticMarkup(<PromptCard prompt={prompt(1, 'fix the bug')} repeatsOpen
      repeats={[prompt(2, 'Fix the BUG'), prompt(3, 'fix the bug'), prompt(4, 'def f():\n    return 1')]} />);
    const earlier = html.slice(html.indexOf('prompt-repeats'));
    expect(earlier).toContain('Fix the BUG');
    expect(earlier).toContain('def f():\n    return 1');
    // The identical repeat adds its source, project, time and id, not its words a second time.
    expect(earlier.match(/prompt-repeat-text/g)?.length).toBe(2);
    expect(earlier.match(/>fix the bug</g)).toBeNull();
  });
});

describe('Copy text on an observation (G4, PR #6229 review)', () => {
  const observation: Observation = {
    id: 4242, project: 'p', platform_source: 'claude', type: 'discovery', title: 'Observation title words',
    subtitle: 'Subtitle words', narrative: 'Narrative words', text: null, facts: '["fact alpha","fact beta"]',
    concepts: '["concept-zeta"]', files_read: '["src/read-only-file.ts"]', files_modified: '["src/modified-only-file.ts"]',
    prompt_number: 1, memory_session_id: 'm', content_session_id: 's', created_at: '', created_at_epoch: 1,
  } as Observation;

  it('copies every section the card can show, as the summary card does, with the card\'s labels in the reader\'s language', () => {
    const copied = observationText(observation, english => `<${english}>`);
    expect(copied).toBe([
      'Observation title words', 'Subtitle words', 'Narrative words',
      '<Facts>\n- fact alpha\n- fact beta', 'concept-zeta', '<read:> src/read-only-file.ts', '<modified:> src/modified-only-file.ts',
    ].join('\n\n'));
  });

  it('leaves out what the observation does not have', () => {
    const bare = { ...observation, subtitle: null, narrative: null, facts: '[]', concepts: null, files_read: '[]', files_modified: null } as unknown as Observation;
    expect(observationText(bare, english => english)).toBe('Observation title words');
  });
});
