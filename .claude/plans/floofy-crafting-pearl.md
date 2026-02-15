# Install ESLint with TypeScript Support

## Context

The magic-claude-mem project (173 source files, 48 test files) has `strict: true` in tsconfig but no linter. The user wants to enforce stricter typing, particularly around `unknown`, `never`, and `any`. There are currently 5 `catch (error: any)` instances, 10 `as any` casts, and 11 `@ts-ignore`/`@ts-nocheck` comments in the codebase. ESLint with `@typescript-eslint` will provide rules to prevent new type safety violations and flag existing ones.

## What Gets Installed

```
eslint                          ^9.x   (flat config format)
@eslint/js                      ^9.x   (recommended JS rules)
typescript-eslint               ^8.x   (parser + plugin + type-aware rules)
eslint-plugin-vitest            ^0.5.x (test file rules)
globals                         ^15.x  (environment globals)
```

## Configuration: `eslint.config.js`

Flat config (ESM, since project uses `"type": "module"`). Three rule layers:

### Layer 1: All TypeScript files (`src/**/*.ts`, `src/**/*.tsx`)
- Extends: `@eslint/js` recommended + `typescript-eslint` strict-type-checked
- Parser: `@typescript-eslint/parser` with `project: './tsconfig.json'`
- Key rules:
  - `@typescript-eslint/no-explicit-any`: `error` — bans `any` type annotations
  - `@typescript-eslint/no-unsafe-assignment`: `error` — bans assigning `any` to typed vars
  - `@typescript-eslint/no-unsafe-call`: `error` — bans calling `any`-typed values
  - `@typescript-eslint/no-unsafe-member-access`: `error` — bans accessing members of `any`
  - `@typescript-eslint/no-unsafe-return`: `error` — bans returning `any` from typed functions
  - `@typescript-eslint/no-unsafe-argument`: `error` — bans passing `any` to typed params
  - `@typescript-eslint/restrict-template-expressions`: `warn` — flags `any` in template literals
  - `@typescript-eslint/no-floating-promises`: `error` — requires awaiting promises
  - `@typescript-eslint/ban-ts-comment`: `error` — bans `@ts-ignore`, allows `@ts-expect-error` with description
  - `@typescript-eslint/consistent-type-imports`: `warn` — enforces `import type` for type-only imports
  - `no-console`: `warn` — encourages logger usage over console.*

### Layer 2: Test files (`tests/**/*.ts`)
- Extends: Layer 1 rules + vitest plugin
- Relaxations:
  - `@typescript-eslint/no-explicit-any`: `warn` (test mocks sometimes need any)
  - `@typescript-eslint/no-unsafe-*`: `warn` (relaxed for test flexibility)
  - `no-console`: `off`

### Layer 3: Ignores
- `node_modules/`, `dist/`, `plugin/`, `docs/`, `*.js`, `*.cjs`, `*.mjs` (build scripts)

## Files Modified

| File | Action |
|------|--------|
| `eslint.config.js` | Create — flat config |
| `package.json` | Add devDependencies + `lint` and `lint:fix` scripts |
| `.gitignore` | Add `.eslintcache` |
| `tsconfig.eslint.json` | Create — extends tsconfig.json, includes both `src/` and `tests/` |

### `tsconfig.eslint.json`

Needed because the main `tsconfig.json` excludes `tests/`. ESLint's type-aware rules need a tsconfig that covers all linted files.

```json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### package.json scripts

```json
{
  "lint": "eslint src/ tests/",
  "lint:fix": "eslint src/ tests/ --fix"
}
```

## Execution Steps

1. Install packages: `npm install -D eslint @eslint/js typescript-eslint eslint-plugin-vitest globals`
2. Create `eslint.config.js` with the three layers described above
3. Create `tsconfig.eslint.json` extending main tsconfig to include tests
4. Add `lint` / `lint:fix` scripts to `package.json`
5. Add `.eslintcache` to `.gitignore`
6. Run `npm run lint` to see current violations (expect errors from the ~21 existing `any`/`@ts-ignore` instances)
7. Do NOT auto-fix existing violations in this step — report count only

## Verification

1. `npm run lint` runs without crashing (exits with error code due to existing violations, but no config errors)
2. `npm run lint -- --max-warnings 0 2>&1 | tail -5` shows summary of violations
3. `npm test` still passes (linter doesn't affect runtime)
4. `npm run build-and-sync` still works

## Out of Scope

- Fixing existing lint violations (separate task)
- Adding Prettier (separate concern)
- Pre-commit hooks (can add later with lint-staged + husky)
- CI integration (can add after violations are fixed)
