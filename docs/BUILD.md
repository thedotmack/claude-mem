# Build & Publish Guide

This repository is now the primary source for `claude-mem`. All builds and publishes happen from this repo.

## Prerequisites

- [Bun](https://bun.sh) - Fast JavaScript runtime and bundler
- npm account with publish access to `claude-mem`

## Building

Build the project to create a bundled, minified executable:

```bash
npm run build
# or
node scripts/build.js
```

This will:
1. Bundle all TypeScript source files using Bun
2. Minify the output
3. Add shebang (`#!/usr/bin/env node`)
4. Set executable permissions
5. Output to `dist/claude-mem.min.js`

### Build Output

- **Entry point:** `src/bin/cli.ts`
- **Output:** `dist/claude-mem.min.js` (~350KB minified)
- **Target:** Node.js (via Bun's `--target=node`)
- **Externals:** `@anthropic-ai/claude-agent-sdk` (not bundled)

## Publishing

To publish a new version to npm:

```bash
npm run publish:npm
# or
node scripts/publish.js
```

The publish script will:
1. Check git status (warn if uncommitted changes)
2. Show current version and prompt for version bump type:
   - `patch` - Bug fixes (1.0.X)
   - `minor` - New features (1.X.0)
   - `major` - Breaking changes (X.0.0)
   - `custom` - Enter version manually
3. Update `package.json` with new version
4. Run build script
5. Run tests (if configured)
6. Create git commit and tag (`v{version}`)
7. Publish to npm
8. Push commit and tags to GitHub

### Manual Publishing

If you prefer to do it manually:

```bash
# 1. Update version in package.json
# 2. Build
npm run build

# 3. Commit and tag
git add package.json dist/
git commit -m "Release v3.9.17"
git tag v3.9.17

# 4. Publish
npm publish

# 5. Push
git push && git push --tags
```

## Development

Run the CLI directly from source without building:

```bash
npm run dev -- [command] [options]
# or
bun run src/bin/cli.ts [command] [options]
```

Example:
```bash
npm run dev -- status
npm run dev -- --version
```

## File Structure

```
claude-mem/
├── src/                    # TypeScript source
│   ├── bin/cli.ts         # CLI entry point
│   ├── commands/          # Command implementations
│   ├── hooks/             # Hook implementations
│   ├── sdk/               # Agent SDK worker
│   ├── services/          # SQLite and path services
│   ├── shared/            # Configuration and types
│   └── utils/             # Platform utilities
├── dist/                  # Build output
│   └── claude-mem.min.js  # Bundled executable
├── tests/                 # Test files
│   ├── database-schema.test.ts
│   ├── sdk-prompts-parser.test.ts
│   ├── hooks-database-integration.test.ts
│   └── session-lifecycle.test.ts
├── docs/                  # Documentation
│   ├── BUILD.md          # This file
│   └── CHANGELOG.md      # Release notes
├── scripts/               # Build automation
│   ├── build.js          # Build script
│   └── publish.js        # Publish script
└── package.json           # Package configuration
```

## Notes

- The build process embeds the version from `package.json` at build time
- `prepublishOnly` script ensures build runs before npm publish
- Dependencies are bundled except for external packages
- The published package includes: `dist/`, `hook-templates/`, `commands/`, `src/`, `docs/`
