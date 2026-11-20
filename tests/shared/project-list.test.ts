import { describe, expect, it } from 'bun:test';
import { parseProjectList, projectsQueryString, projectsQueryValues } from '../../src/shared/project-list.js';
import { scopedProjects } from '../../src/services/sqlite/project-read-keys.js';

describe('parseProjectList', () => {
  it('trims a comma-separated string, because a person typed it', () => {
    expect(parseProjectList('api, web')).toEqual(['api', 'web']);
    expect(parseProjectList(' api ,, web ,')).toEqual(['api', 'web']);
  });

  it('keeps one key exactly: a query string cannot send a one-entry list any other way', () => {
    expect(parseProjectList('topic ')).toEqual(['topic ']);
  });

  it('keeps list entries exactly', () => {
    expect(parseProjectList(['topic ', 'parent'])).toEqual(['topic ', 'parent']);
    expect(parseProjectList(['api,web', 'parent'])).toEqual(['api,web', 'parent']);
    expect(parseProjectList('["api,web","parent"]')).toEqual(['api,web', 'parent']);
  });

  it('drops blank entries and anything that is not text', () => {
    expect(parseProjectList(' ')).toEqual([]);
    expect(parseProjectList(['', '\t', 7, null, 'api'])).toEqual(['api']);
    expect(parseProjectList(undefined)).toEqual([]);
    expect(parseProjectList('[null]')).toEqual(['[null]']);
  });

  // Same two characters, two meanings: in a list ' api' is a different checkout
  // from 'api'; in a typed comma string the space is only formatting.
  it('tells api and " api" apart only in the list form', () => {
    expect(scopedProjects({ projects: parseProjectList(['api', ' api']) })).toEqual(['api', ' api']);
    expect(scopedProjects({ projects: parseProjectList('api, api') })).toEqual(['api']);
  });
});

describe('projectsQueryValues', () => {
  it('sends the usual comma form when no key carries outer whitespace', () => {
    expect(projectsQueryValues(['parent', 'topic'])).toEqual(['parent,topic']);
  });

  it('repeats the query key when one does, so it survives the round trip', () => {
    const values = projectsQueryValues(['parent', 'topic ']);
    expect(values).toEqual(['parent', 'topic ']);
    expect(parseProjectList(values)).toEqual(['parent', 'topic ']);
    expect(parseProjectList(new URLSearchParams(projectsQueryString(['parent', 'topic '])).getAll('projects'))).toEqual(['parent', 'topic ']);
  });

  it('round-trips a single key with whitespace', () => {
    const [only] = new URLSearchParams(projectsQueryString(['topic '])).getAll('projects');
    expect(parseProjectList(only)).toEqual(['topic ']);
  });

  it('round-trips exact comma and JSON-looking keys through a single query value', () => {
    for (const projects of [['api,web'], ['parent', ' api,web '], ['["api"]'], ['[api]'], ['[,]', '"quoted",key']]) {
      const values = new URLSearchParams(projectsQueryString(projects)).getAll('projects');
      expect(values).toHaveLength(1);
      expect(parseProjectList(values[0])).toEqual(projects);
    }
  });
});
