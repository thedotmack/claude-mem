import { describe, expect, it } from 'bun:test';

import { getPrimaryContextProject } from '../../src/services/context/ContextBuilder.js';

describe('getPrimaryContextProject', () => {
  it('prefers the last raw project when dream and raw namespaces are interleaved', () => {
    expect(
      getPrimaryContextProject(
        ['project-a', 'project-a:dream', 'project-b:dream', 'project-b'],
        'fallback-project'
      )
    ).toBe('project-b');
  });

  it('falls back to the context primary project when only dream namespaces are supplied', () => {
    expect(
      getPrimaryContextProject(
        ['project-a:dream', 'project-b:dream'],
        'fallback-project'
      )
    ).toBe('fallback-project');
  });
});
