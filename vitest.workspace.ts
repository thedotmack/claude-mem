import { defineProject } from 'vitest/config';

/**
 * Workspace project definitions for vitest v4.
 *
 * Two named projects:
 *  - unit:        all tests except the SDK subprocess harness
 *  - integration: SDK harness tests only (requires live claude CLI)
 *
 * Consumed by vitest.config.ts via test.projects.
 * Use: vitest run --project unit | vitest run --project integration
 */
export const workspaceProjects = [
  defineProject({
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['tests/**/*.test.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.spec.ts',
        'tests/integration/sdk-harness.test.ts',
      ],
    },
  }),
  defineProject({
    test: {
      name: 'integration',
      include: ['tests/integration/sdk-harness.test.ts'],
      testTimeout: 120_000,
      hookTimeout: 30_000,
      pool: 'forks',
    },
  }),
];
