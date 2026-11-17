import { afterEach, describe, expect, it } from 'bun:test';

import { cleanupGeneratedProjects, generateIn } from '../helpers/claude-md-generate';

afterEach(cleanupGeneratedProjects);

describe('generateClaudeMd', () => {
  it('yields to the event loop while regenerating folders', () => {
    // The probe immediate is scheduled before the call, so it runs in the check
    // phase that the generation loop yields to. If generation never yields, the
    // await continuation runs first and the probe runs only afterwards.
    const script = `
      let yieldedDuringGeneration = false;
      const probe = setImmediate(() => { yieldedDuringGeneration = true; });
      const code = await generateClaudeMd(false);
      clearImmediate(probe);
      if (code !== 0) process.exitCode = code;
      if (!yieldedDuringGeneration) {
        console.error('generateClaudeMd did not yield to the event loop');
        process.exitCode = 1;
      }
    `;

    const project = generateIn({
      files: ['src/a.ts', 'src/b.ts'],
      seed: '',
      script,
    });

    expect(project).toBeTruthy();
  });
});
