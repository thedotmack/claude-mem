# Contributing to cmem

cmem is a TypeScript CLI for context memory management. Contributions are welcome — please read this guide before opening a PR.

---

## Prerequisites

- **Node.js 18+** — minimum runtime version
- **Bun** — used for development, testing, and building

Install Bun:

```bash
curl -fsSL https://bun.sh/install | bash
```

---

## Setup

```bash
git clone https://github.com/aryateja2106/cmem
cd cmem
bun install
```

Verify the setup:

```bash
# Type check
bun run lint

# Run tests
bun test

# Run the CLI locally
bun run src/index.ts -- --help
bun run src/index.ts -- search "test" --json
bun run src/index.ts -- stats --json
```

Build the distributable:

```bash
bun run build
node dist/index.js --help
```

---

## Project Structure

```
src/
  index.ts              CLI entry — registers all commands with Commander
  types.ts              TypeScript interfaces (mirrors worker API responses)
  config.ts             Config resolution (env vars > settings.json > defaults)
  memory-client.ts      IMemoryClient interface — the backend abstraction
  client.ts             WorkerClient — HTTP implementation of IMemoryClient
  client-factory.ts     Factory — resolves the correct backend from config
  output.ts             Dual-mode output (human tables vs agent JSON)
  errors.ts             ExitCode enum, CLIError, error factories

  commands/             One file per subcommand
  formatters/           table.ts, json.ts, icons.ts, markdown.ts
  tmux/                 sidebar.ts, sse-consumer.ts, renderer.ts
  utils/                detect.ts, validate.ts, privacy.ts, version.ts
```

---

## Adding a Command

1. Create `src/commands/<name>.ts`.

2. Export a registration function:

   ```typescript
   import type { Command } from 'commander';
   import { createMemoryClient } from '../client-factory.js';
   import { loadConfig } from '../config.js';
   import { detectOutputMode } from '../utils/detect.js';
   import { validateQuery } from '../utils/validate.js';
   import { outputResult, outputError } from '../output.js';

   export function registerMyCommand(program: Command): void {
     program
       .command('my-command <query>')
       .description('Brief description of what this does')
       .option('--limit <n>', 'max results', '20')
       .option('--project <name>', 'filter by project')
       .option('--json', 'structured JSON output')
       .action(async (query: string, opts) => {
         const mode = detectOutputMode(opts);
         const validated = validateQuery(query);       // always validate first
         const config = loadConfig();
         const client = createMemoryClient(config);    // use the factory, never WorkerClient directly

         try {
           const result = await client.search({ query: validated, limit: Number(opts.limit) });
           outputResult(result, mode);
         } catch (err) {
           outputError(err, mode);
         }
       });
   }
   ```

3. Register in `src/index.ts`:

   ```typescript
   import { registerMyCommand } from './commands/my-command.js';
   // ...
   registerMyCommand(program);
   ```

4. Add `--json` support — every command must support both human and agent output modes. Use `detectOutputMode` to choose.

5. Validate all inputs before calling the client. Use the validators in `src/utils/validate.ts`.

6. Write tests in `tests/commands/<name>.test.ts`. Cover the success path, not-found case, and connection error.

7. Update the module map in `AGENTS.md`.

---

## Adding a Backend

Backends implement the `IMemoryClient` interface defined in `src/memory-client.ts`.

1. Create `src/clients/<name>-client.ts`:

   ```typescript
   import type { IMemoryClient } from '../memory-client.js';
   // ... import all required types

   export class MyBackendClient implements IMemoryClient {
     // Implement every method in the interface.
     // Throw CLIError with appropriate ExitCode for all error conditions.
   }
   ```

2. Register in `src/client-factory.ts`:

   ```typescript
   export function createMemoryClient(config: CMEMConfig): IMemoryClient {
     if (config.backend === 'my-backend') {
       return new MyBackendClient(config);
     }
     return new WorkerClient(config);
   }
   ```

3. Extend `CMEMConfig` in `src/config.ts` if the new backend requires additional configuration fields.

4. Document the backend in the README backend support table.

All backends must:
- Strip `<private>` tags from any text they return (even if the backend does it too)
- Throw `CLIError` with a meaningful `ExitCode`, never raw errors
- Be localhost-only unless explicitly architected for remote use with security review

---

## Code Style

- **TypeScript strict mode** — `"strict": true` in `tsconfig.json`. No `any`, no non-null assertions without justification.
- **ESM throughout** — all imports use `.js` extensions (required for ESM Node.js).
- **No unused imports** — the TypeScript compiler will catch these; fix them, do not suppress.
- **Named exports only** — no default exports. This keeps refactoring predictable.
- **Error types** — use `CLIError` from `src/errors.ts`. Never throw raw strings or generic `Error` objects from commands.
- **No new dependencies without justification** — cmem has 3 runtime dependencies by design. Adding a dependency requires a comment in the PR explaining why the existing tooling is insufficient.

Run the type checker before every commit:

```bash
bun run lint
```

---

## PR Checklist

Before submitting a pull request, verify:

- [ ] `bun run lint` passes with zero errors
- [ ] `bun test` passes with zero failures
- [ ] New command or backend is registered and callable end-to-end
- [ ] All user inputs are validated before reaching the backend
- [ ] `--json` output follows the stable `CLIResponse` envelope schema
- [ ] Exit codes match the documented semantic contract
- [ ] `AGENTS.md` module map is updated if you added a file
- [ ] No new runtime dependencies added without justification in the PR description
- [ ] No `<private>` tag content appears in any output path

---

## Security Policy

- **Input validation is not optional.** Every string that comes from the user or from a file passes through `src/utils/validate.ts` before reaching the client.
- **No secrets in output.** `<private>` tags must be stripped. Check `src/utils/privacy.ts`.
- **No remote connections.** The default and intended deployment is localhost only. Any PR that adds remote connection support will require a separate security review.
- **Settings allowlist.** The `settings set` command only accepts keys in the allowlist in `src/utils/validate.ts`. New settings keys must be explicitly added to that list.

If you discover a security issue, please report it privately via GitHub Security Advisories rather than opening a public issue.

---

## Running Tests

```bash
# All tests
bun test

# Watch mode during development
bun test --watch

# Specific test file
bun test tests/commands/search.test.ts
```

Tests use Bun's built-in test runner. No separate framework to install.

---

## Commit Style

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(commands): add branch-status command
fix(validate): reject null bytes in observation IDs
docs(readme): update backend support table
refactor(client): extract timeout logic into helper
test(search): add not-found case coverage
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`.

---

## License

By contributing, you agree that your contributions will be licensed under AGPL-3.0, matching the project license.
