import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    // Use forks for process isolation — prevents process.exit side effects
    // from modules like worker-service.ts leaking across tests
    pool: 'forks',
    // Exclude Playwright spec files — they use @playwright/test and conflict with vitest's expect
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.spec.ts'],
  },
});
