// Gate P2-5: the model only sees a checkout's current project key (the
// SessionStart header), so an MCP search for it used to miss the memory that
// checkout wrote under its older keys. A search for the checkout's own key now
// covers all of them; any other project is searched exactly as asked.
import { describe, expect, it } from 'bun:test';
import { withCheckoutProjects } from '../../src/servers/checkout-search-scope.js';

const checkout = { primary: 'acme/api', allProjects: ['api', 'acme/api'] };

describe('withCheckoutProjects (gate P2-5)', () => {
  it('extends a search for the checkout\'s own key to every key it reads', () => {
    expect(withCheckoutProjects({ query: 'retry', project: 'acme/api' }, checkout))
      .toEqual({ query: 'retry', project: 'acme/api', projects: 'api,acme/api' });
    expect(withCheckoutProjects({ project: 'ACME/API' }, checkout)).toMatchObject({ projects: 'api,acme/api' });
  });

  it('searches any other project exactly as asked', () => {
    expect(withCheckoutProjects({ project: 'other' }, checkout)).toEqual({ project: 'other' });
  });

  it('keeps an explicit project list, and an unscoped search unscoped', () => {
    expect(withCheckoutProjects({ project: 'acme/api', projects: 'acme/api' }, checkout))
      .toEqual({ project: 'acme/api', projects: 'acme/api' });
    expect(withCheckoutProjects({ query: 'retry' }, checkout)).toEqual({ query: 'retry' });
  });

  it('changes nothing for a checkout with a single key', () => {
    expect(withCheckoutProjects({ project: 'api' }, { primary: 'api', allProjects: ['api'] })).toEqual({ project: 'api' });
  });
});
