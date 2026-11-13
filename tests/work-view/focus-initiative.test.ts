import { describe, expect, it } from 'bun:test';
import { MAX_FOCUS_INITIATIVE_CHARS, initiativeKey, projectDisplayName, withFocusInitiatives } from '../../src/services/work-view/focus-initiative.mjs';

const root = (project: unknown) => typeof project === 'string' ? project.split('/')[0] : null;
const area = (focusAreaId: string, initiative: string | null = null) => ({ focusAreaId, name: focusAreaId, initiative });
const request = (focusAreaId: string | undefined, projects: string[], updatedAtEpoch = 0) => ({ focusAreaId, projects, updatedAtEpoch });
const guessOf = (requests: ReturnType<typeof request>[]) => withFocusInitiatives([area('fa_a')], requests, root)[0];

describe('a focus area\'s initiative', () => {
  it('is the owner\'s assignment whenever there is one, whatever folders its requests ran in', () => {
    const [filed] = withFocusInitiatives([area('fa_a', 'Kite maps')], [request('fa_a', ['harbor'], 100), request('fa_a', ['harbor'], 200)], root);
    expect(filed).toMatchObject({ initiative: 'Kite maps', folders: ['harbor'] });
    expect(filed).not.toHaveProperty('initiativeGuess');
  });

  it('is a guess, marked as one, when the owner assigned none: the folder most of its requests ran in', () => {
    expect(guessOf([request('fa_a', ['atlas'], 900), request('fa_a', ['harbor'], 100), request('fa_a', ['harbor'], 200)]))
      .toMatchObject({ initiative: 'harbor', initiativeGuess: true, folders: ['harbor', 'atlas'] });
  });

  it('guesses the folder with the most recent activity on a tie, then the name that sorts first', () => {
    expect(guessOf([request('fa_a', ['atlas'], 100), request('fa_a', ['harbor'], 300)]).initiative).toBe('harbor');
    expect(guessOf([request('fa_a', ['harbor'], 300), request('fa_a', ['atlas'], 300)]).initiative).toBe('atlas');
  });

  it('counts a request once for each folder it ran in, and a repo\'s worktrees as one folder', () => {
    expect(guessOf([request('fa_a', ['atlas/fix-a', 'atlas/fix-b'], 100), request('fa_a', ['harbor', 'atlas'], 100), request('fa_a', ['harbor'], 900), request('fa_a', ['atlas'], 50)]).initiative).toBe('atlas');
  });

  it('is none for an area with no assignment and no known folder', () => {
    const [none, unknown, other] = withFocusInitiatives([area('fa_none'), area('fa_unknown'), area('fa_other')],
      [request('fa_unknown', [''], 100), request('fa_unknown', [], 200), request(undefined, ['atlas'], 300), request('fa_elsewhere', ['atlas'], 300)], root);
    for (const entry of [none, unknown, other]) {
      expect(entry.initiative).toBeNull();
      expect(entry).not.toHaveProperty('initiativeGuess');
      expect(entry).not.toHaveProperty('folders');
    }
  });

  it('gives no guess to an area the owner filed under no initiative', () => {
    const [none] = withFocusInitiatives([{ ...area('fa_a'), initiativeNone: true as const }], [request('fa_a', ['harbor'], 100)], root);
    expect(none.initiative).toBeNull();
    expect(none).not.toHaveProperty('initiativeGuess');
  });

  it('spells a guess the way the owner spells that initiative, so both sit under one heading', () => {
    const [owned, guessed] = withFocusInitiatives([area('fa_a', 'Harbor'), area('fa_b')], [request('fa_b', ['harbor'], 100)], root);
    expect(owned.initiative).toBe('Harbor');
    expect(guessed).toMatchObject({ initiative: 'Harbor', initiativeGuess: true });
  });

  it('matches names by case and outer spaces only', () => {
    expect(initiativeKey('  Kite Maps ')).toBe(initiativeKey('kite maps'));
    expect(initiativeKey('Kite Maps')).not.toBe(initiativeKey('KiteMaps'));
    expect(initiativeKey(null)).toBe('');
  });

  it('names a folder by its root and never by a folder path', () => {
    expect(projectDisplayName('atlas/fix-a', root)).toBe('atlas');
    expect(projectDisplayName('acme/atlas', (project) => project as string)).toBe('acme/atlas');
    expect(projectDisplayName('/srv/checkouts/atlas', (project) => project as string)).toBe('atlas');
    expect(projectDisplayName('C:\\work\\atlas', (project) => project as string)).toBe('atlas');
    expect(projectDisplayName('', root)).toBeNull();
    expect(projectDisplayName(null, root)).toBeNull();
    expect(projectDisplayName('p'.repeat(200), root)).toHaveLength(MAX_FOCUS_INITIATIVE_CHARS);
  });
});
