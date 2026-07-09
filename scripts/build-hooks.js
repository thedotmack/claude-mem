#!/usr/bin/env node

import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKER_SERVICE = {
  name: 'worker-service',
  source: 'src/services/worker-service.ts'
};

const SERVER_SERVICE = {
  name: 'server-service',
  source: 'src/server/runtime/ServerService.ts'
};

const MCP_SERVER = {
  name: 'mcp-server',
  source: 'src/entrypoints/mcp-server.ts'
};

const CONTEXT_GENERATOR = {
  name: 'context-generator',
  source: 'src/services/context-generator.ts'
};

const TRANSCRIPT_WATCHER = {
  name: 'transcript-watcher',
  source: 'src/services/transcripts/transcript-watcher-entry.ts'
};

function stripHardcodedDirname(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  const before = content.length;

  const str = `(?:"[^"]*"|'[^']*')`;

  for (const id of ['__dirname', '__filename']) {
    content = content.replace(new RegExp(`\\bvar ${id}\\s*=\\s*${str},\\s*`, 'g'), 'var ');
    content = content.replace(new RegExp(`\\bvar ${id}\\s*=\\s*${str};\\s*`, 'g'), '');
    content = content.replace(new RegExp(`,\\s*${id}\\s*=\\s*${str}`, 'g'), '');
  }

  content = content.replace(/\bvar\s*;/g, '');
  content = content.replace(/[ \t]+$/gm, '');

  const removed = before - content.length;
  if (removed > 0) {
    fs.writeFileSync(filePath, content);
    console.log(`  ✓ Stripped hardcoded __dirname/__filename paths (${removed} bytes)`);
  }
}

/**
 * Rule A canonical-template manifest: maps each host-managed config file's
 * command string to the buildShellCommand() options that generate it. The
 * build asserts the hand-maintained files still match the generator output so
 * the defensive shell prelude can't drift between the three files (issues
 * #1215, #1533). See src/build/hook-shell-template.ts and CLAUDE.md →
 * "Spawn-Contract Resolution".
 */
function shellTemplateManifest(buildShellCommand, buildCodexWindowsCommand) {
  const ccTrailing = (...tail) => [
    'node', '"$_P/scripts/bun-runner.js"', '"$_P/scripts/worker-service.cjs"', ...tail,
  ];
  const claudeHook = (tail, extra = {}) => buildShellCommand({
    host: 'claude-code', requireFile: 'bun-runner.js', requireFileSecondary: 'worker-service.cjs',
    trailingCommand: ccTrailing(...tail), notFoundMessage: 'claude-mem: plugin scripts not found', ...extra,
  });
  const codexHook = (tail) => buildShellCommand({
    host: 'codex-cli', requireFile: 'bun-runner.js', requireFileSecondary: 'worker-service.cjs',
    trailingCommand: ccTrailing(...tail), notFoundMessage: 'claude-mem: plugin scripts not found',
    extraEnv: { CLAUDE_MEM_CODEX_HOOK: '1' },
  });
  const codexStartupHook = () => buildShellCommand({
    host: 'codex-cli', requireFile: 'bun-runner.js', requireFileSecondary: 'worker-service.cjs',
    trailingCommand: [
      '_V=$(CLAUDE_MEM_CODEX_HOOK=1 node "$_P/scripts/version-check.js" || true);',
      'if [ -n "$_V" ]; then printf \'%s\\n\' "$_V"; else',
      'CLAUDE_MEM_CODEX_HOOK=1', ...ccTrailing('hook', 'codex', 'context'),
      '; fi',
    ],
    notFoundMessage: 'claude-mem: plugin scripts not found',
  });
  const codexHookPair = (tail, options = {}) => ({
    command: options.startupVersionCheck ? codexStartupHook() : codexHook(tail),
    commandWindows: buildCodexWindowsCommand(tail, options),
  });

  return {
    'plugin/hooks/hooks.json': {
      kind: 'hooks',
      commands: {
        'Setup.0.0': buildShellCommand({
          host: 'claude-code-setup', requireFile: 'version-check.js',
          trailingCommand: ['node', '"$_P/scripts/version-check.js"'],
          notFoundMessage: 'claude-mem: version-check.js not found',
        }),
        'SessionStart.0.0': claudeHook(['hook', 'claude-code', 'context']),
        'UserPromptSubmit.0.0': claudeHook(['hook', 'claude-code', 'session-init']),
        'PostToolUse.0.0': claudeHook(['hook', 'claude-code', 'observation']),
        'PreToolUse.0.0': claudeHook(['hook', 'claude-code', 'file-context']),
        'Stop.0.0': claudeHook(['hook', 'claude-code', 'summarize']),
        'PreCompact.0.0': claudeHook(['hook', 'claude-code', 'pre-compact']),
      },
    },
    'plugin/hooks/codex-hooks.json': {
      kind: 'hooks',
      commands: {
        'SessionStart.0.0': codexHookPair(['hook', 'codex', 'context'], { startupVersionCheck: true }),
        'UserPromptSubmit.0.0': codexHookPair(['hook', 'codex', 'session-init']),
        'PreToolUse.0.0': codexHookPair(['hook', 'codex', 'file-context']),
        'PostToolUse.0.0': codexHookPair(['hook', 'codex', 'observation']),
        'Stop.0.0': codexHookPair(['hook', 'codex', 'summarize']),
      },
    },
    'plugin/.mcp.json': {
      kind: 'mcp',
      command: buildShellCommand({
        // The mcp Node launcher derives its spawn target from requireFile, so
        // no trailingCommand is needed (it is ignored for this host).
        host: 'mcp', requireFile: 'mcp-server.cjs',
        notFoundMessage: 'claude-mem: mcp server not found',
        mcpExtraCandidates: ['$PWD/plugin', '$PWD'],
        mcpExtraCacheRoots: [
          '$HOME/.codex/plugins/cache/claude-mem-local/claude-mem',
          '$HOME/.codex/plugins/cache/thedotmack/claude-mem',
        ],
      }),
    },
  };
}

function hookEntryByPath(parsed, dottedPath) {
  const [event, groupIdx, hookIdx] = dottedPath.split('.');
  return parsed.hooks?.[event]?.[Number(groupIdx)]?.hooks?.[Number(hookIdx)] ?? null;
}

async function loadCanonicalBuildShellCommand() {
  // Compile src/build/hook-shell-template.ts in-memory and import it. The build
  // runs under Node, which can't import .ts directly, so we bundle to ESM and
  // load via a data: URL.
  const bundled = await build({
    entryPoints: ['src/build/hook-shell-template.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'error',
  });
  const moduleSource = bundled.outputFiles[0].text;
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64');
  const { buildShellCommand } = await import(dataUrl);
  return buildShellCommand;
}

function renderManagedHookFiles(buildShellCommand) {
  const manifest = shellTemplateManifest(buildShellCommand);
  return {
    'plugin/hooks/hooks.json': {
      description: 'Claude-mem memory system hooks',
      hooks: {
        Setup: [{
          matcher: '*',
          hooks: [{ type: 'command', shell: 'bash', command: manifest['plugin/hooks/hooks.json'].commands['Setup.0.0'], timeout: 300 }],
        }],
        SessionStart: [{
          matcher: 'startup|clear|compact',
          hooks: [{ type: 'command', shell: 'bash', command: manifest['plugin/hooks/hooks.json'].commands['SessionStart.0.0'], timeout: 60 }],
        }],
        UserPromptSubmit: [{
          hooks: [{ type: 'command', shell: 'bash', command: manifest['plugin/hooks/hooks.json'].commands['UserPromptSubmit.0.0'], timeout: 60 }],
        }],
        PostToolUse: [{
          matcher: '*',
          hooks: [{ type: 'command', shell: 'bash', command: manifest['plugin/hooks/hooks.json'].commands['PostToolUse.0.0'], timeout: 120 }],
        }],
        PreToolUse: [{
          matcher: 'Read',
          hooks: [{ type: 'command', shell: 'bash', command: manifest['plugin/hooks/hooks.json'].commands['PreToolUse.0.0'], timeout: 60 }],
        }],
        Stop: [{
          hooks: [{ type: 'command', shell: 'bash', command: manifest['plugin/hooks/hooks.json'].commands['Stop.0.0'], timeout: 120 }],
        }],
      },
    },
    'plugin/hooks/codex-hooks.json': {
      description: 'claude-mem Codex CLI hook integration',
      hooks: {
        SessionStart: [{
          matcher: 'startup|resume',
          hooks: [
            { type: 'command', command: manifest['plugin/hooks/codex-hooks.json'].commands['SessionStart.0.0'], timeout: 5 },
            { type: 'command', command: manifest['plugin/hooks/codex-hooks.json'].commands['SessionStart.0.1'], timeout: 60 },
            {
              type: 'command',
              command: manifest['plugin/hooks/codex-hooks.json'].commands['SessionStart.0.2'],
              timeout: 60,
              statusMessage: 'Loading claude-mem context',
            },
          ],
        }],
        UserPromptSubmit: [{
          hooks: [{ type: 'command', command: manifest['plugin/hooks/codex-hooks.json'].commands['UserPromptSubmit.0.0'], timeout: 60 }],
        }],
        PreToolUse: [{
          matcher: '^Bash$|^mcp__.+__(read|view|cat)(_file|_files)?$',
          hooks: [{ type: 'command', command: manifest['plugin/hooks/codex-hooks.json'].commands['PreToolUse.0.0'], timeout: 30 }],
        }],
        PostToolUse: [{
          matcher: '.*',
          hooks: [{ type: 'command', command: manifest['plugin/hooks/codex-hooks.json'].commands['PostToolUse.0.0'], timeout: 120 }],
        }],
        Stop: [{
          hooks: [{ type: 'command', command: manifest['plugin/hooks/codex-hooks.json'].commands['Stop.0.0'], timeout: 60 }],
        }],
      },
    },
    'plugin/.mcp.json': {
      mcpServers: {
        'mcp-search': {
          type: 'stdio',
          command: 'node',
          args: ['-e', manifest['plugin/.mcp.json'].command],
        },
      },
    },
  };
}

async function writeManagedHookFiles() {
  console.log('\n📋 Regenerating host-managed hook files...');
  const buildShellCommand = await loadCanonicalBuildShellCommand();
  const files = renderManagedHookFiles(buildShellCommand);
  for (const [filePath, content] of Object.entries(files)) {
    fs.writeFileSync(filePath, `${JSON.stringify(content, null, 2)}\n`);
  }
  console.log('✓ Host-managed hook files regenerated from src/build/hook-shell-template.ts');
}

async function verifyShellTemplateCanonical() {
  console.log('\n📋 Verifying Rule A shell templates match the canonical generator...');

  const buildShellCommand = await loadCanonicalBuildShellCommand();

  const manifest = shellTemplateManifest(buildShellCommand, buildCodexWindowsCommand);

  for (const [filePath, spec] of Object.entries(manifest)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (spec.kind === 'mcp') {
      const actual = parsed.mcpServers?.['mcp-search']?.args?.[1] ?? '';
      if (actual !== spec.command) {
        throw new Error(
          `Hand-edited shell string detected in ${filePath} (mcp-search). It no longer matches src/build/hook-shell-template.ts. ` +
          `Update the generator (and this manifest) instead of hand-editing the launcher.`
        );
      }
    } else {
      for (const [dottedPath, expected] of Object.entries(spec.commands)) {
        const entry = hookEntryByPath(parsed, dottedPath);
        const expectedCommand = typeof expected === 'string' ? expected : expected.command;
        const actual = entry?.command ?? null;
        if (actual !== expectedCommand) {
          throw new Error(
            `Hand-edited shell string detected in ${filePath} (${dottedPath}). It no longer matches src/build/hook-shell-template.ts. ` +
            `Regenerate via the canonical generator instead of hand-editing the command.`
          );
        }
        if (typeof expected !== 'string') {
          const actualWindows = entry?.commandWindows ?? null;
          if (actualWindows !== expected.commandWindows) {
            throw new Error(
              `Hand-edited Windows shell string detected in ${filePath} (${dottedPath}). It no longer matches src/build/hook-shell-template.ts. ` +
              `Regenerate via the canonical generator instead of hand-editing commandWindows.`
            );
          }
        }
      }
    }
  }

  // Rule C safety net (bun-runner.js fixBrokenScriptPath) must stay documented.
  const bunRunner = fs.readFileSync('plugin/scripts/bun-runner.js', 'utf-8');
  if (!bunRunner.includes('function fixBrokenScriptPath')) {
    throw new Error(
      'plugin/scripts/bun-runner.js is missing fixBrokenScriptPath — it is the Rule C runtime safety net behind Rule A. Do not remove it.'
    );
  }

  // Parser-compat guard (issue #2791): bun-runner.js is invoked by hosts that
  // may run a pre-ES2020 Node whose ESM loader throws on optional chaining.
  // Strip comments, then forbid `?.` / `??` in executable code.
  const bunRunnerCode = bunRunner
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (/\?\.|\?\?/.test(bunRunnerCode)) {
    throw new Error(
      'plugin/scripts/bun-runner.js uses optional chaining (?.) or nullish coalescing (??) — ' +
      'this launcher must parse on pre-ES2020 Node (issue #2791). Rewrite with explicit guards.'
    );
  }

  console.log('✓ Rule A shell templates match the canonical generator');
}

async function buildHooks() {
  console.log('🔨 Building claude-mem hooks and worker service...\n');

  try {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    const version = packageJson.version;
    console.log(`📌 Version: ${version}`);

    console.log('\n📦 Preparing output directories...');
    const hooksDir = 'plugin/scripts';
    const uiDir = 'plugin/ui';

    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }
    if (!fs.existsSync(uiDir)) {
      fs.mkdirSync(uiDir, { recursive: true });
    }
    console.log('✓ Output directories ready');

    console.log('\n📦 Generating plugin package.json...');
    const pluginPackageJson = {
      name: 'claude-mem-plugin',
      version: version,
      private: true,
      description: 'Runtime dependencies for claude-mem bundled hooks',
      type: 'module',
      // Hook-critical, pure-JS deps that MUST install for the worker to boot.
      // Kept here (not in optionalDependencies) so a failure fails the build.
      dependencies: {
        'zod': '^4.3.6',
        // @modelcontextprotocol/sdk validates tool schemas with Ajv. mcp-server.cjs
        // bundles the SDK, but Ajv emits compiled validators that require its runtime
        // helpers by package path (e.g. require("ajv/dist/runtime/equal")), which
        // esbuild leaves external. Without Ajv in the plugin's node_modules the MCP
        // server crashes on the first tool call. See also the zod guardrail below.
        'ajv': '^8.20.0',
        'ajv-formats': '^3.0.1',
        'tree-sitter-cli': '^0.26.5',
        'tree-sitter-c': '^0.24.1',
        'tree-sitter-cpp': '^0.23.4',
        'tree-sitter-go': '^0.25.0',
        'tree-sitter-java': '^0.23.5',
        'tree-sitter-javascript': '^0.25.0',
        'tree-sitter-python': '^0.25.0',
        'tree-sitter-ruby': '^0.23.1',
        'tree-sitter-rust': '^0.24.0',
        'tree-sitter-typescript': '^0.23.2',
        'tree-sitter-kotlin': '^0.3.8',
        'tree-sitter-swift': '^0.7.1',
        'tree-sitter-php': '^0.24.2',
        '@tree-sitter-grammars/tree-sitter-lua': '^0.4.1',
        'tree-sitter-scala': '^0.24.0',
        'tree-sitter-bash': '^0.25.1',
        'tree-sitter-haskell': '^0.23.1',
        '@tree-sitter-grammars/tree-sitter-zig': '^1.1.2',
        'tree-sitter-css': '^0.25.0',
        'tree-sitter-scss': '^1.0.0',
        '@tree-sitter-grammars/tree-sitter-toml': '^0.7.0',
        '@tree-sitter-grammars/tree-sitter-yaml': '^0.7.1',
        '@derekstride/tree-sitter-sql': '^0.3.11',
        '@tree-sitter-grammars/tree-sitter-markdown': '^0.3.2',
      },
      overrides: {
        'tree-sitter': '^0.25.0'
      },
      trustedDependencies: [
        'tree-sitter-cli'
      ],
      engines: {
        node: '>=20.12.0',
        bun: '>=1.0.0'
      }
    };
    fs.writeFileSync('plugin/package.json', JSON.stringify(pluginPackageJson, null, 2) + '\n');
    console.log('✓ plugin/package.json generated');

    // Populate plugin/node_modules so the bundled worker can resolve its
    // externalized runtime deps (zod/v3, shell-quote, tree-sitter grammars).
    // The worker bundle marks these `external`, so without an installed
    // plugin/node_modules every hook crashes at runtime with
    // `Cannot find module 'zod/v3'` (issues #2407 / #2453 / #2640 / #2379).
    //
    // The result must also ship: the `plugin/node_modules` entry in root
    // package.json `files` carries it into the npm tarball (npm only
    // force-strips a *top-level* node_modules, not a nested one named
    // explicitly in `files` — verified via `npm pack`).
    //
    // npm (not bun) so CI/publishers without bun still work. We do NOT pass
    // --ignore-scripts: tree-sitter grammars use prebuild-install postinstalls
    // to fetch prebuilt .node bindings. Install is fail-soft (grammars are
    // optionalDependencies); the resolve gate near the end of this build is
    // the hard guard that zod/v3 actually landed.
    console.log('\n📦 Installing plugin runtime dependencies into plugin/node_modules...');
    {
      const { spawnSync: spawnInstall } = await import('node:child_process');
      const installResult = spawnInstall('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: path.join(__dirname, '..', 'plugin'),
        stdio: 'inherit',
        // npm on Windows is a .cmd shim — spawn without shell hits ENOENT.
        shell: process.platform === 'win32',
      });
      if (installResult.error) {
        console.warn(`⚠️  Could not invoke npm in plugin/: ${installResult.error.message}. Run \`cd plugin && npm install\` manually.`);
      } else if (installResult.status === 0) {
        console.log('✓ plugin/node_modules populated');
      } else {
        console.warn(`⚠️  npm install in plugin/ exited with code ${installResult.status}. Run \`cd plugin && npm install\` manually.`);
      }
    }

    console.log('\n📋 Building React viewer...');
    const { spawn } = await import('child_process');
    const viewerBuild = spawn('node', ['scripts/build-viewer.js'], { stdio: 'inherit' });
    await new Promise((resolve, reject) => {
      viewerBuild.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Viewer build failed with exit code ${code}`));
        }
      });
    });

    console.log(`\n🔧 Building worker service...`);
    await build({
      entryPoints: [WORKER_SERVICE.source],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: `${hooksDir}/${WORKER_SERVICE.name}.cjs`,
      minify: true,
      logLevel: 'error', // Suppress warnings (import.meta warning is benign)
      external: [
        'bun:sqlite',
        'cohere-ai',
        'ollama',
        '@chroma-core/default-embed',
        'onnxruntime-node',
        // better-auth (~3.7MB) is only reachable through BetterAuthRoutes' request-time
        // dynamic import('better-auth/node') / import('./auth.js'). esbuild otherwise
        // inlines that dynamic-import target into the worker bundle, dragging in the full
        // better-auth library (kysely, oauth, nanoid, …) even though the worker never
        // exercises it (the dep isn't in the worker's runtime plugin/package.json deps,
        // and the route handler already wraps the import in try/catch → graceful 500).
        // Keeping it external strips the dead weight from worker-service.cjs. See #2584.
        'better-auth',
        'better-auth/node',
        'better-auth/plugins',
        '@better-auth/api-key',
      ],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`,
        // Polyfill import.meta.url for ESM deps bundled into CJS output.
        // @anthropic-ai/claude-agent-sdk's *.mjs files use createRequire(import.meta.url)
        // and `new URL(rel, import.meta.url)`. We map import.meta.url to a file:// URL
        // (not the raw __filename path) so URL construction preserves its semantics.
        'import.meta.url': '__IMPORT_META_URL__'
      },
      banner: {
        js: [
          '#!/usr/bin/env bun',
          'var __filename = __filename || require("node:path").resolve(process.argv[1] || "");',
          'var __dirname = __dirname || require("node:path").dirname(__filename);',
          'var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__filename).href;'
        ].join('\n')
      }
    });

    stripHardcodedDirname(`${hooksDir}/${WORKER_SERVICE.name}.cjs`);

    fs.chmodSync(`${hooksDir}/${WORKER_SERVICE.name}.cjs`, 0o755);
    const workerStats = fs.statSync(`${hooksDir}/${WORKER_SERVICE.name}.cjs`);
    console.log(`✓ worker-service built (${(workerStats.size / 1024).toFixed(2)} KB)`);

    // Advisory only — a sudden jump usually means a heavy server-only dependency
    // (better-auth, kysely, a database driver) leaked into the worker bundle via a
    // transitive import (#2584). Never blocks the build.
    const WORKER_SERVICE_MAX_BYTES = 2900 * 1024;
    if (workerStats.size > WORKER_SERVICE_MAX_BYTES) {
      console.warn(
        `⚠️  worker-service.cjs is ${(workerStats.size / 1024).toFixed(2)} KB (advisory budget ${(WORKER_SERVICE_MAX_BYTES / 1024).toFixed(0)} KB). ` +
        `If this jumped unexpectedly, check whether a server-only dependency leaked into the worker bundle (see #2584).`
      );
    }

    // worker-service.cjs lazy-requires these via createRequire("../sqlite/…"),
    // intentionally kept external from the worker bundle (#2584). They must ship
    // as sibling files under plugin/sqlite/, or clean installs can throw
    // "Cannot find module '../sqlite/SessionStore.js'" when Chroma vector sync
    // reaches the SQLite helpers (#3107/#3126).
    console.log(`\n🔧 Building sqlite runtime modules...`);
    const SQLITE_MODULES = [
      { source: 'src/services/sqlite/SessionStore.ts', out: 'plugin/sqlite/SessionStore.js' },
      { source: 'src/services/sqlite/observations/files.ts', out: 'plugin/sqlite/observations/files.js' },
    ];
    for (const mod of SQLITE_MODULES) {
      fs.mkdirSync(path.dirname(mod.out), { recursive: true });
      await build({
        entryPoints: [mod.source],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        outfile: mod.out,
        minify: true,
        logLevel: 'error',
        external: [
          'bun:sqlite',
          'zod',
          'cohere-ai',
          'ollama',
          '@chroma-core/default-embed',
          'onnxruntime-node',
          'better-auth',
          'better-auth/node',
          'better-auth/plugins',
          '@better-auth/api-key',
        ],
        define: {
          '__DEFAULT_PACKAGE_VERSION__': `"${version}"`,
          'import.meta.url': '__IMPORT_META_URL__'
        },
        banner: {
          js: 'var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__filename).href;'
        }
      });
      console.log(`✓ ${mod.out} built (${(fs.statSync(mod.out).size / 1024).toFixed(2)} KB)`);
    }

    console.log(`\n🔧 Building server beta service...`);
    await build({
      entryPoints: [SERVER_SERVICE.source],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: `${hooksDir}/${SERVER_SERVICE.name}.cjs`,
      minify: true,
      logLevel: 'error',
      external: [
        'bun:sqlite',
        'zod',
      ],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      },
      banner: {
        js: [
          '#!/usr/bin/env bun',
          'var __filename = __filename || require("node:path").resolve(process.argv[1] || "");',
          'var __dirname = __dirname || require("node:path").dirname(__filename);'
        ].join('\n')
      }
    });

    stripHardcodedDirname(`${hooksDir}/${SERVER_SERVICE.name}.cjs`);

    fs.chmodSync(`${hooksDir}/${SERVER_SERVICE.name}.cjs`, 0o755);
    const serverStats = fs.statSync(`${hooksDir}/${SERVER_SERVICE.name}.cjs`);
    console.log(`✓ server-service built (${(serverStats.size / 1024).toFixed(2)} KB)`);

    console.log(`\n🔧 Building MCP server...`);
    await build({
      entryPoints: [MCP_SERVER.source],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: `${hooksDir}/${MCP_SERVER.name}.cjs`,
      minify: true,
      logLevel: 'error',
      external: [
        'bun:sqlite',
        'tree-sitter-cli',
        'tree-sitter-javascript',
        'tree-sitter-typescript',
        'tree-sitter-python',
        'tree-sitter-go',
        'tree-sitter-rust',
        'tree-sitter-ruby',
        'tree-sitter-java',
        'tree-sitter-c',
        'tree-sitter-cpp',
        'tree-sitter-kotlin',
        'tree-sitter-swift',
        'tree-sitter-php',
        '@tree-sitter-grammars/tree-sitter-lua',
        'tree-sitter-scala',
        'tree-sitter-bash',
        'tree-sitter-haskell',
        '@tree-sitter-grammars/tree-sitter-zig',
        'tree-sitter-css',
        'tree-sitter-scss',
        '@tree-sitter-grammars/tree-sitter-toml',
        '@tree-sitter-grammars/tree-sitter-yaml',
        '@derekstride/tree-sitter-sql',
        '@tree-sitter-grammars/tree-sitter-markdown',
      ],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      },
      banner: {
        js: '#!/usr/bin/env node'
      }
    });

    stripHardcodedDirname(`${hooksDir}/${MCP_SERVER.name}.cjs`);

    fs.chmodSync(`${hooksDir}/${MCP_SERVER.name}.cjs`, 0o755);
    const mcpServerStats = fs.statSync(`${hooksDir}/${MCP_SERVER.name}.cjs`);
    console.log(`✓ mcp-server built (${(mcpServerStats.size / 1024).toFixed(2)} KB)`);

    const mcpBundleContent = fs.readFileSync(`${hooksDir}/${MCP_SERVER.name}.cjs`, 'utf-8');
    const bunRequireRegex = /require\(\s*["']bun:[a-z][a-z0-9_-]*["']\s*\)/;
    const bunRequireMatch = mcpBundleContent.match(bunRequireRegex);
    if (bunRequireMatch) {
      throw new Error(
        `mcp-server.cjs contains a Bun-only ${bunRequireMatch[0]} call. This means a transitive import in src/entrypoints/mcp-server.ts pulled in code from worker-service.ts (or another module that touches DatabaseManager/ChromaSync). The MCP server runs under Node and cannot load bun:* modules. Audit recent imports in src/entrypoints/mcp-server.ts and src/services/worker-spawner.ts — the spawner module is intentionally lightweight and MUST NOT import anything that touches SQLite or other Bun-only modules. See PR #1645 for context.`
      );
    }
    const zodRequireRegex = /require\(\s*["']zod(?:\/[^"']*)?["']\s*\)/;
    const zodRequireMatch = mcpBundleContent.match(zodRequireRegex);
    if (zodRequireMatch) {
      throw new Error(
        `mcp-server.cjs contains external ${zodRequireMatch[0]}. Claude Desktop can launch this bundle without plugin node_modules available, so Zod must be bundled into the MCP server.`
      );
    }
    // Ajv (via @modelcontextprotocol/sdk) emits compiled validators that require
    // their runtime helpers by package path, which esbuild cannot inline. Those
    // externals are acceptable ONLY if the package is declared in the plugin's
    // dependencies so `bun install` provides them at runtime. Guard against the
    // silent regression where the require survives the bundle but the dep is missing.
    for (const ajvPkg of ['ajv', 'ajv-formats']) {
      const ajvRequireRegex = new RegExp(`require\\(\\s*["']${ajvPkg}(?:/[^"']*)?["']\\s*\\)`);
      if (ajvRequireRegex.test(mcpBundleContent) && !pluginPackageJson.dependencies[ajvPkg]) {
        throw new Error(
          `mcp-server.cjs requires external "${ajvPkg}" but it is missing from the generated plugin/package.json dependencies. Add it to the dependencies list in scripts/build-hooks.js so the plugin cache install can resolve it at runtime.`
        );
      }
    }

    const MCP_SERVER_MAX_BYTES = 600 * 1024;
    if (mcpServerStats.size > MCP_SERVER_MAX_BYTES) {
      console.warn(
        `⚠️  mcp-server.cjs is ${(mcpServerStats.size / 1024).toFixed(2)} KB (advisory budget ${(MCP_SERVER_MAX_BYTES / 1024).toFixed(0)} KB). If this jumped unexpectedly, a transitive import may have pulled worker-service.ts or another heavy module into the MCP bundle (see #1645).`
      );
    }

    console.log(`\n🔧 Building context generator...`);
    await build({
      entryPoints: [CONTEXT_GENERATOR.source],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: `${hooksDir}/${CONTEXT_GENERATOR.name}.cjs`,
      minify: true,
      logLevel: 'error',
      external: ['bun:sqlite', 'zod'],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      },
      // No banner needed: CJS files under Node.js have __dirname/__filename natively
    });

    stripHardcodedDirname(`${hooksDir}/${CONTEXT_GENERATOR.name}.cjs`);

    const contextGenStats = fs.statSync(`${hooksDir}/${CONTEXT_GENERATOR.name}.cjs`);
    console.log(`✓ context-generator built (${(contextGenStats.size / 1024).toFixed(2)} KB)`);

    console.log(`\n🔧 Building transcript watcher...`);
    await build({
      entryPoints: [TRANSCRIPT_WATCHER.source],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: `${hooksDir}/${TRANSCRIPT_WATCHER.name}.cjs`,
      minify: true,
      logLevel: 'error',
      // Externalize zod for consistency with worker-service / server-beta-service —
      // any zod usage in the processor.ts import chain should resolve at runtime
      // against plugin/node_modules instead of being inlined (avoids duplicate-
      // instance hazards and keeps the bundle slim).
      external: ['bun:sqlite', 'zod'],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      },
      banner: {
        js: '#!/usr/bin/env bun'
      }
    });

    stripHardcodedDirname(`${hooksDir}/${TRANSCRIPT_WATCHER.name}.cjs`);

    fs.chmodSync(`${hooksDir}/${TRANSCRIPT_WATCHER.name}.cjs`, 0o755);
    const transcriptWatcherStats = fs.statSync(`${hooksDir}/${TRANSCRIPT_WATCHER.name}.cjs`);
    console.log(`✓ transcript-watcher built (${(transcriptWatcherStats.size / 1024).toFixed(2)} KB)`);

    // Advisory only — the watcher is meant to be a thin file-tail loop.
    const TRANSCRIPT_WATCHER_MAX_BYTES = 200 * 1024;
    if (transcriptWatcherStats.size > TRANSCRIPT_WATCHER_MAX_BYTES) {
      console.warn(
        `⚠️  transcript-watcher.cjs is ${(transcriptWatcherStats.size / 1024).toFixed(2)} KB (advisory budget ${(TRANSCRIPT_WATCHER_MAX_BYTES / 1024).toFixed(0)} KB). If this jumped unexpectedly, check src/services/transcripts/processor.ts and watcher.ts for heavy imports.`
      );
    }

    console.log(`\n🔧 Building NPX CLI...`);
    const npxCliOutDir = 'dist/npx-cli';
    if (!fs.existsSync(npxCliOutDir)) {
      fs.mkdirSync(npxCliOutDir, { recursive: true });
    }
    await build({
      entryPoints: ['src/npx-cli/index.ts'],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'esm',
      outfile: `${npxCliOutDir}/index.js`,
      banner: { js: '#!/usr/bin/env node' },
      minify: true,
      logLevel: 'error',
      external: [
        'fs', 'fs/promises', 'path', 'os', 'child_process', 'url',
        'crypto', 'http', 'https', 'net', 'stream', 'util', 'events',
        'buffer', 'querystring', 'readline', 'tty', 'assert',
        'bun:sqlite',
      ],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      },
    });

    fs.chmodSync(`${npxCliOutDir}/index.js`, 0o755);
    const npxCliStats = fs.statSync(`${npxCliOutDir}/index.js`);
    console.log(`✓ npx-cli built (${(npxCliStats.size / 1024).toFixed(2)} KB)`);

    if (fs.existsSync('openclaw/src/index.ts')) {
      console.log(`\n🔧 Building OpenClaw plugin...`);
      const openclawOutDir = 'openclaw/dist';
      if (!fs.existsSync(openclawOutDir)) {
        fs.mkdirSync(openclawOutDir, { recursive: true });
      }
      await build({
        entryPoints: ['openclaw/src/index.ts'],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'esm',
        outfile: `${openclawOutDir}/index.js`,
        minify: true,
        logLevel: 'error',
        external: [
          'fs', 'fs/promises', 'path', 'os', 'child_process', 'url',
          'crypto', 'http', 'https', 'net', 'stream', 'util', 'events',
        ],
      });

      const openclawStats = fs.statSync(`${openclawOutDir}/index.js`);
      console.log(`✓ openclaw plugin built (${(openclawStats.size / 1024).toFixed(2)} KB)`);
    }

    if (fs.existsSync('src/integrations/opencode-plugin/index.ts')) {
      console.log(`\n🔧 Building OpenCode plugin...`);
      const opencodeOutDir = 'dist/opencode-plugin';
      if (!fs.existsSync(opencodeOutDir)) {
        fs.mkdirSync(opencodeOutDir, { recursive: true });
      }
      await build({
        entryPoints: ['src/integrations/opencode-plugin/index.ts'],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'esm',
        outfile: `${opencodeOutDir}/index.js`,
        minify: true,
        logLevel: 'error',
        external: [
          'fs', 'fs/promises', 'path', 'os', 'child_process', 'url',
          'crypto', 'http', 'https', 'net', 'stream', 'util', 'events',
        ],
      });

      const opencodeStats = fs.statSync(`${opencodeOutDir}/index.js`);
      console.log(`✓ opencode plugin built (${(opencodeStats.size / 1024).toFixed(2)} KB)`);
    }

    console.log('\n📦 Installing plugin runtime dependencies into plugin/node_modules...');
    // Why this exists: with better-auth externalized from the worker bundle
    // (PR #2596 / issue #2584) and the existing zod + tree-sitter externals,
    // the worker now relies on `plugin/node_modules` being populated at
    // runtime. Marketplace installs already get this via `sync-marketplace.cjs`
    // running `bun install` post-rsync, but:
    //   1. Dev workflow (`bun plugin/scripts/worker-service.cjs start`) was
    //      broken — repo-local plugin/ had no node_modules until you synced.
    //   2. The npm tarball (`npm install -g claude-mem` → `npx claude-mem
    //      install`) ships plugin/package.json but no plugin/node_modules
    //      (issue #2407), so the worker fails with `Cannot find module 'zod/v3'`.
    //
    // Running install here fixes (1) outright and is a prerequisite for the
    // npm tarball fix (which bundles plugin/node_modules into the published
    // tarball — coming in a follow-up PR). We use `npm install` not `bun
    // install` so this works on CI / publishers that may not have bun.
    //
    // We intentionally DO NOT pass --ignore-scripts: tree-sitter grammar
    // packages rely on prebuild-install (a postinstall script) to download
    // prebuilt .node bindings for the current arch. With --ignore-scripts
    // the bindings never arrive and the MCP server fails to load any
    // grammar. prebuild-install handles cross-platform via prebuilt
    // binaries; only on niche archs (linux arm64 without prebuilt) does it
    // fall back to node-gyp compilation. If the install fails entirely
    // (e.g. node-gyp prerequisites missing on a publisher's machine), we
    // log a warning but don't abort the build — the maintainer can resolve
    // it before publishing.
    try {
      const { spawn: spawnInstall } = await import('node:child_process');
      // shell: true on Windows is critical — npm there is a .cmd batch file,
      // not a bare executable, so spawn('npm', ...) without shell hits ENOENT
      // and the fail-soft handler below would silently leave Windows builds
      // with an empty plugin/node_modules.
      // cwd anchored to __dirname (not process.cwd()) so the step works even
      // if the script is invoked from outside the repo root.
      const installResult = spawnInstall('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: path.join(__dirname, '..', 'plugin'),
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      await new Promise((resolve) => {
        let errorHandled = false;
        installResult.on('error', (err) => {
          errorHandled = true;
          console.warn(`⚠️  Could not invoke npm in plugin/: ${err.message}. The build artifact is still valid, but you'll need to run \`cd plugin && npm install\` manually.`);
          resolve();
        });
        installResult.on('exit', (code) => {
          if (errorHandled) { resolve(); return; }
          if (code === 0) {
            console.log('✓ plugin/node_modules populated');
          } else {
            console.warn(`⚠️  npm install in plugin/ exited with code ${code}. The build artifact is still valid, but you'll need to run \`cd plugin && npm install\` manually before the worker can resolve external dependencies (zod, better-auth, tree-sitter grammars).`);
          }
          resolve();
        });
      });
    } catch (installError) {
      console.warn(`⚠️  plugin/ install raised: ${installError.message}. Continuing — artifacts are still valid.`);
    }

    console.log('\n📋 Copying onboarding explainer to plugin tree...');
    const onboardingExplainerSrc = 'src/services/worker/onboarding-explainer.md';
    const onboardingExplainerDst = 'plugin/skills/how-it-works/onboarding-explainer.md';
    if (!fs.existsSync(onboardingExplainerSrc)) {
      throw new Error(`Missing onboarding explainer source: ${onboardingExplainerSrc}`);
    }
    fs.mkdirSync(path.dirname(onboardingExplainerDst), { recursive: true });
    fs.copyFileSync(onboardingExplainerSrc, onboardingExplainerDst);
    console.log(`✓ Copied ${onboardingExplainerSrc} → ${onboardingExplainerDst}`);

    await writeManagedHookFiles();

    console.log('\n📋 Verifying distribution files...');
    const validCodexHookEvents = new Set([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'Stop',
    ]);
    const requiredDistributionFiles = [
      'plugin/skills/mem-search/SKILL.md',
      'plugin/skills/smart-explore/SKILL.md',
      'plugin/skills/how-it-works/SKILL.md',
      'plugin/skills/how-it-works/onboarding-explainer.md',
      'plugin/hooks/hooks.json',
      'plugin/hooks/codex-hooks.json',
      'plugin/scripts/bun-runner.js',
      'plugin/sqlite/SessionStore.js',
      'plugin/sqlite/observations/files.js',
      'plugin/.claude-plugin/plugin.json',
      'plugin/.codex-plugin/plugin.json',
      'plugin/.mcp.json',
      '.codex-plugin/plugin.json',
      '.agents/plugins/marketplace.json',
    ];
    for (const filePath of requiredDistributionFiles) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Missing required distribution file: ${filePath}`);
      }
    }
    const codexHooks = JSON.parse(fs.readFileSync('plugin/hooks/codex-hooks.json', 'utf-8'));
    const validCodexHookRootKeys = new Set(['hooks']);
    for (const rootKey of Object.keys(codexHooks)) {
      if (!validCodexHookRootKeys.has(rootKey)) {
        throw new Error(`plugin/hooks/codex-hooks.json contains unsupported Codex root key: ${rootKey}`);
      }
    }
    for (const eventName of Object.keys(codexHooks.hooks ?? {})) {
      if (!validCodexHookEvents.has(eventName)) {
        throw new Error(`plugin/hooks/codex-hooks.json contains unknown Codex hook event: ${eventName}`);
      }
    }
    const codexMarketplace = JSON.parse(fs.readFileSync('.agents/plugins/marketplace.json', 'utf-8'));
    const claudeMemMarketplaceEntry = (codexMarketplace.plugins ?? []).find((plugin) => plugin.name === 'claude-mem');
    if (claudeMemMarketplaceEntry?.source?.path !== './plugin') {
      throw new Error('.agents/plugins/marketplace.json must point claude-mem source.path at ./plugin so Codex loads the bundled plugin root');
    }
    const bundledMcp = JSON.parse(fs.readFileSync('plugin/.mcp.json', 'utf-8'));
    const mcpSearchCommand = bundledMcp.mcpServers?.['mcp-search']?.args?.join(' ') ?? '';
    if (!mcpSearchCommand.includes('.codex/plugins/cache/claude-mem-local/claude-mem')) {
      throw new Error('plugin/.mcp.json mcp-search launcher must include Codex cache fallback for hosts that do not inject PLUGIN_ROOT');
    }
    if (!mcpSearchCommand.includes('plugins/cache/thedotmack/claude-mem')) {
      throw new Error('plugin/.mcp.json mcp-search launcher must include Claude cache fallback for hosts that do not inject PLUGIN_ROOT');
    }
    console.log('✓ All required distribution files present');

    await verifyShellTemplateCanonical();

    // Hard gate: prove the worker's externalized runtime deps actually resolve
    // from plugin/node_modules. The install step above is fail-soft (grammars
    // are optionalDependencies), so this is the real guard against shipping a
    // build that crashes every hook with `Cannot find module 'zod'`
    // (#2407 / #2379).
    console.log('\n📋 Verifying plugin runtime deps resolve...');
    {
      const { createRequire } = await import('node:module');
      const pluginNodeModules = path.join(__dirname, '..', 'plugin', 'node_modules');
      const pluginRequire = createRequire(path.join(__dirname, '..', 'plugin', 'package.json'));
      for (const dep of ['zod', 'shell-quote']) {
        let resolved;
        try {
          resolved = pluginRequire.resolve(dep);
        } catch {
          throw new Error(`Plugin runtime dep '${dep}' does not resolve at all — the bundled worker would crash at runtime. Run \`cd plugin && npm install\` and rebuild.`);
        }
        // require.resolve walks UP to the repo-root node_modules, where zod and
        // shell-quote also exist as build-time deps — so a successful resolve does
        // NOT prove plugin/node_modules is populated. Assert the resolved path is
        // actually inside plugin/node_modules, which is what ships in the npm
        // tarball (root package.json `files`) and what every hook resolves from
        // at runtime.
        if (!resolved.startsWith(pluginNodeModules + path.sep)) {
          throw new Error(`Plugin runtime dep '${dep}' resolved from ${resolved}, OUTSIDE plugin/node_modules — plugin/node_modules is not populated, so the npm tarball / fresh marketplace install would crash every hook with \`Cannot find module '${dep}'\`. Run \`cd plugin && npm install\` and rebuild.`);
        }
      }
    }
    console.log('✓ Plugin runtime deps resolve (zod, shell-quote)');

    console.log('\n✅ All build targets compiled successfully!');
    console.log(`   Output: ${hooksDir}/`);
    console.log(`   - Worker: worker-service.cjs`);
    console.log(`   - Server: server-service.cjs`);
    console.log(`   - MCP Server: mcp-server.cjs`);
    console.log(`   - Context Generator: context-generator.cjs`);
    console.log(`   - Transcript Watcher: transcript-watcher.cjs`);
    console.log(`   Output: ${npxCliOutDir}/`);
    console.log(`   - NPX CLI: index.js`);
    if (fs.existsSync('openclaw/dist/index.js')) {
      console.log(`   Output: openclaw/dist/`);
      console.log(`   - OpenClaw Plugin: index.js`);
    }
    if (fs.existsSync('dist/opencode-plugin/index.js')) {
      console.log(`   Output: dist/opencode-plugin/`);
      console.log(`   - OpenCode Plugin: index.js`);
    }

  } catch (error) {
    console.error('\n❌ Build failed:', error.message);
    if (error.errors) {
      console.error('\nBuild errors:');
      error.errors.forEach(err => console.error(`  - ${err.text}`));
    }
    process.exit(1);
  }
}

buildHooks();
