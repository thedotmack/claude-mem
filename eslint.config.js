import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import vitest from 'eslint-plugin-vitest';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // Layer 3: Global ignores
  {
    ignores: [
      'node_modules/',
      'dist/',
      'plugin/',
      'docs/',
      'private/',
      'datasets/',
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
      // Don't ignore this config file itself
      '!eslint.config.js',
    ],
  },

  // Layer 1: Source files — strict type-checked rules
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Type safety — ban any
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // Template expressions
      '@typescript-eslint/restrict-template-expressions': 'warn',

      // Promise handling
      '@typescript-eslint/no-floating-promises': 'error',

      // Ban @ts-ignore, allow @ts-expect-error with description
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],

      // Unused variables — allow underscore-prefixed args and destructured vars
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // Import style
      '@typescript-eslint/consistent-type-imports': 'warn',

      // Encourage logger over console
      'no-console': 'warn',
    },
  },

  // Layer 1b: Browser UI files — console is the only logging option + React hooks rules
  {
    files: ['src/ui/**/*.ts', 'src/ui/**/*.tsx'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'no-console': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Layer 1c: CLI scripts and entry points — console is correct for user-facing output
  {
    files: ['src/bin/**/*.ts', 'src/cli/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // Layer 1d: Files where console usage is intentional (not convertible to logger)
  {
    files: [
      'src/utils/logger.ts',                              // Logger itself uses console
      'src/servers/mcp-server.ts',                         // MCP protocol stdout interception
      'src/services/worker-service.ts',                    // CLI entry point with user-facing output
      'src/services/sqlite/migrations.ts',                 // Migration progress runs before logger init
      'src/services/integrations/CursorHooksInstaller.ts', // Standalone installer, user-facing output
      'src/shared/SettingsDefaultsManager.ts',             // Avoids circular dependency with logger
    ],
    rules: {
      'no-console': 'off',
    },
  },

  // Layer 2: Test files — relaxed for mocks/flexibility
  {
    files: ['tests/**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
    ],
    plugins: {
      vitest,
    },
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Relaxed type safety for tests
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',

      // Keep these strict even in tests
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],

      // Unused variables — allow underscore-prefixed args and destructured vars
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // No console restriction in tests
      'no-console': 'off',

      // Vitest mock assertions like expect(mock.method).toHaveBeenCalled()
      // trigger false positives — mocks don't use 'this'
      '@typescript-eslint/unbound-method': 'off',

      // Vitest rules
      'vitest/expect-expect': 'warn',
      'vitest/no-identical-title': 'error',
      'vitest/no-focused-tests': 'error',
    },
  },
);
