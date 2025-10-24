# Development Guide

## Building from Source

### Prerequisites

- Node.js 18.0.0 or higher
- npm (comes with Node.js)
- Git

### Clone and Build

```bash
# Clone repository
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem

# Install dependencies
npm install

# Build all components
npm run build
```

### Build Process

The build process uses esbuild to compile TypeScript:

1. Compiles TypeScript to JavaScript
2. Creates standalone executables for each hook in `plugin/scripts/`
3. Bundles MCP search server to `plugin/scripts/search-server.js`
4. Bundles worker service to `plugin/scripts/worker-service.cjs`

**Build Output**:
- Hook executables: `*-hook.js` (ESM format)
- Worker service: `worker-service.cjs` (CJS format)
- Search server: `search-server.js` (ESM format)

### Build Scripts

```bash
# Build everything
npm run build

# Build only hooks
npm run build:hooks

# The build script is defined in scripts/build-hooks.js
```

## Development Workflow

### 1. Make Changes

Edit TypeScript source files in `src/`:

```
src/
├── bin/hooks/       # Hook entry points
├── hooks/           # Hook implementations
├── services/        # Worker service and database
├── servers/         # MCP search server
├── sdk/             # Claude Agent SDK integration
├── shared/          # Shared utilities
└── utils/           # General utilities
```

### 2. Build

```bash
npm run build
```

### 3. Test

```bash
# Run all tests
npm test

# Test specific file
node --test tests/session-lifecycle.test.ts

# Test context injection
npm run test:context

# Verbose context test
npm run test:context:verbose
```

### 4. Manual Testing

```bash
# Start worker manually
npm run worker:start

# Check worker status
npm run worker:status

# View logs
npm run worker:logs

# Test hooks manually
echo '{"session_id":"test-123","cwd":"'$(pwd)'","source":"startup"}' | node plugin/scripts/context-hook.js
```

### 5. Iterate

Repeat steps 1-4 until your changes work as expected.

## Adding New Features

### Adding a New Hook

1. Create hook implementation in `src/hooks/your-hook.ts`:

```typescript
import { HookInput } from './types';

export async function yourHook(input: HookInput) {
  // Hook implementation
  return {
    hookSpecificOutput: 'Optional output'
  };
}
```

2. Create entry point in `src/bin/hooks/your-hook.ts`:

```typescript
#!/usr/bin/env node
import { readStdin } from '../../shared/stdin';
import { yourHook } from '../../hooks/your-hook';

async function main() {
  const input = await readStdin();
  const result = await yourHook(input);
  console.log(JSON.stringify(result));
}

main().catch(console.error);
```

3. Add to `plugin/hooks/hooks.json`:

```json
{
  "YourHook": [{
    "hooks": [{
      "type": "command",
      "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/your-hook.js",
      "timeout": 120
    }]
  }]
}
```

4. Rebuild:

```bash
npm run build
```

### Modifying Database Schema

1. Add migration to `src/services/sqlite/migrations.ts`:

```typescript
export const migration011: Migration = {
  version: 11,
  up: (db: Database) => {
    db.run(`
      ALTER TABLE observations ADD COLUMN new_field TEXT;
    `);
  },
  down: (db: Database) => {
    // Optional: define rollback
  }
};
```

2. Update types in `src/services/sqlite/types.ts`:

```typescript
export interface Observation {
  // ... existing fields
  new_field?: string;
}
```

3. Update database methods in `src/services/sqlite/SessionStore.ts`:

```typescript
createObservation(obs: Observation) {
  // Include new_field in INSERT
}
```

4. Test migration:

```bash
# Backup database first!
cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.backup

# Run tests
npm test
```

### Extending SDK Prompts

1. Modify prompts in `src/sdk/prompts.ts`:

```typescript
export function buildObservationPrompt(observation: Observation): string {
  return `
    <observation>
      <!-- Add new XML structure -->
    </observation>
  `;
}
```

2. Update parser in `src/sdk/parser.ts`:

```typescript
export function parseObservation(xml: string): ParsedObservation {
  // Parse new XML fields
}
```

3. Test:

```bash
npm test
```

### Adding MCP Search Tools

1. Add tool definition in `src/servers/search-server.ts`:

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'your_new_tool') {
    // Implement tool logic
    const results = await search.yourNewSearch(params);
    return formatResults(results);
  }
});
```

2. Add search method in `src/services/sqlite/SessionSearch.ts`:

```typescript
yourNewSearch(params: YourParams): SearchResult[] {
  // Implement FTS5 search
}
```

3. Rebuild and test:

```bash
npm run build
npm test
```

## Testing

### Running Tests

```bash
# All tests
npm test

# Specific test file
node --test tests/your-test.test.ts

# With coverage (if configured)
npm test -- --coverage
```

### Writing Tests

Create test files in `tests/`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('YourFeature', () => {
  it('should do something', () => {
    // Test implementation
    assert.strictEqual(result, expected);
  });
});
```

### Test Database

Use a separate test database:

```typescript
import { SessionStore } from '../src/services/sqlite/SessionStore';

const store = new SessionStore(':memory:'); // In-memory database
```

## Code Style

### TypeScript Guidelines

- Use TypeScript strict mode
- Define interfaces for all data structures
- Use async/await for asynchronous code
- Handle errors explicitly
- Add JSDoc comments for public APIs

### Formatting

- Follow existing code formatting
- Use 2-space indentation
- Use single quotes for strings
- Add trailing commas in objects/arrays

### Example

```typescript
/**
 * Create a new observation in the database
 */
export async function createObservation(
  obs: Observation
): Promise<number> {
  try {
    const result = await db.insert('observations', {
      session_id: obs.session_id,
      tool_name: obs.tool_name,
      // ...
    });
    return result.id;
  } catch (error) {
    logger.error('Failed to create observation', error);
    throw error;
  }
}
```

## Debugging

### Enable Debug Logging

```bash
export DEBUG=claude-mem:*
npm run worker:restart
npm run worker:logs
```

### Inspect Database

```bash
sqlite3 ~/.claude-mem/claude-mem.db

# View schema
.schema observations

# Query data
SELECT * FROM observations LIMIT 10;
```

### Trace Observations

Use correlation IDs to trace observations through the pipeline:

```bash
sqlite3 ~/.claude-mem/claude-mem.db
SELECT correlation_id, tool_name, created_at
FROM observations
WHERE session_id = 'YOUR_SESSION_ID'
ORDER BY created_at;
```

### Debug Hooks

Run hooks manually with test input:

```bash
# Test context hook
echo '{"session_id":"test-123","cwd":"'$(pwd)'","source":"startup"}' | node plugin/scripts/context-hook.js

# Test new hook
echo '{"session_id":"test-123","cwd":"'$(pwd)'","prompt":"test"}' | node plugin/scripts/new-hook.js
```

## Publishing

### NPM Publishing

```bash
# Update version in package.json
npm version patch  # or minor, or major

# Build
npm run build

# Publish to NPM
npm run release
```

The `release` script:
1. Runs tests
2. Builds all components
3. Publishes to NPM registry

### Creating a Release

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Commit changes
4. Create git tag
5. Push to GitHub
6. Publish to NPM

```bash
# Update version
npm version 4.2.4

# Update changelog
# Edit CHANGELOG.md manually

# Commit
git add .
git commit -m "chore: Release v4.2.4"

# Tag
git tag v4.2.4

# Push
git push origin main --tags

# Publish to NPM
npm run release
```

## Contributing

### Contribution Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Write tests
5. Update documentation
6. Commit your changes (`git commit -m 'Add amazing feature'`)
7. Push to the branch (`git push origin feature/amazing-feature`)
8. Open a Pull Request

### Pull Request Guidelines

- **Clear title**: Describe what the PR does
- **Description**: Explain why the change is needed
- **Tests**: Include tests for new features
- **Documentation**: Update docs as needed
- **Changelog**: Add entry to CHANGELOG.md
- **Commits**: Use clear, descriptive commit messages

### Code Review Process

1. Automated tests must pass
2. Code review by maintainer
3. Address feedback
4. Final approval
5. Merge to main

## Development Tools

### Recommended VSCode Extensions

- TypeScript
- ESLint
- Prettier
- SQLite Viewer

### Useful Commands

```bash
# Check TypeScript types
npx tsc --noEmit

# Lint code (if configured)
npm run lint

# Format code (if configured)
npm run format

# Clean build artifacts
rm -rf plugin/scripts/*.js plugin/scripts/*.cjs
```

## Troubleshooting Development

### Build Fails

1. Clean node_modules:
   ```bash
   rm -rf node_modules
   npm install
   ```

2. Check Node.js version:
   ```bash
   node --version  # Should be >= 18.0.0
   ```

3. Check for syntax errors:
   ```bash
   npx tsc --noEmit
   ```

### Tests Fail

1. Check database:
   ```bash
   rm ~/.claude-mem/claude-mem.db
   npm test
   ```

2. Check worker status:
   ```bash
   npm run worker:status
   ```

3. View logs:
   ```bash
   npm run worker:logs
   ```

### Worker Won't Start

1. Kill existing process:
   ```bash
   pm2 delete claude-mem-worker
   ```

2. Check port:
   ```bash
   lsof -i :37777
   ```

3. Try custom port:
   ```bash
   export CLAUDE_MEM_WORKER_PORT=38000
   npm run worker:start
   ```

## Next Steps

- [Architecture Overview](architecture/overview.md) - Understand the system
- [Configuration](configuration.md) - Customize Claude-Mem
- [Troubleshooting](troubleshooting.md) - Common issues
