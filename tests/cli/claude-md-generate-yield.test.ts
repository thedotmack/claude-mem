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

  it('yields again when a later batch starts', () => {
    // 30 leaf folders plus their parents exceed one batch of 25, so generation
    // must reach the check phase exactly twice (folders 1 and 26). Counting
    // setImmediate calls observes the batch boundaries without depending on
    // wall-clock timing.
    const files = Array.from(
      { length: 30 },
      (_, index) => `src/folder-${String(index).padStart(2, '0')}/file.ts`,
    );
    const script = `
      let yields = 0;
      const original = globalThis.setImmediate;
      globalThis.setImmediate = (callback, ...args) => {
        yields += 1;
        return original(callback, ...args);
      };
      try {
        const code = await generateClaudeMd(false);
        if (code !== 0) process.exitCode = code;
      } finally {
        globalThis.setImmediate = original;
      }
      if (yields !== 2) {
        console.error('generateClaudeMd yielded ' + yields + ' time(s); expected 2 batch boundaries');
        process.exitCode = 1;
      }
    `;

    const project = generateIn({ files, seed: '', script });

    expect(project).toBeTruthy();
  });
});
