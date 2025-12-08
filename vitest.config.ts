import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Exclude node:test format files (they use node's native test runner)
      'tests/strip-memory-tags.test.ts',
      'tests/user-prompt-tag-stripping.test.ts'
    ],
  },
});
