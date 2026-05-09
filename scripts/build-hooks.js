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

const SERVER_BETA_SERVICE = {
  name: 'server-beta-service',
  source: 'src/server/runtime/ServerBetaService.ts'
};

const MCP_SERVER = {
  name: 'mcp-server',
  source: 'src/servers/mcp-server.ts'
};

const CONTEXT_GENERATOR = {
  name: 'context-generator',
  source: 'src/services/context-generator.ts'
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
      dependencies: {
        'zod': '^4.3.6',
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
        'tree-sitter-elixir': '^0.3.5',
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
        'shell-quote': '^1.8.3',
      },
      overrides: {
        'tree-sitter': '^0.25.0'
      },
      trustedDependencies: [
        'tree-sitter-cli'
      ],
      engines: {
        node: '>=18.0.0',
        bun: '>=1.0.0'
      }
    };
    fs.writeFileSync('plugin/package.json', JSON.stringify(pluginPackageJson, null, 2) + '\n');
    console.log('✓ plugin/package.json generated');

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
        'zod',
        'cohere-ai',
        'ollama',
        '@chroma-core/default-embed',
        'onnxruntime-node'
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

    console.log(`\n🔧 Building server beta service...`);
    await build({
      entryPoints: [SERVER_BETA_SERVICE.source],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: `${hooksDir}/${SERVER_BETA_SERVICE.name}.cjs`,
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

    stripHardcodedDirname(`${hooksDir}/${SERVER_BETA_SERVICE.name}.cjs`);

    fs.chmodSync(`${hooksDir}/${SERVER_BETA_SERVICE.name}.cjs`, 0o755);
    const serverBetaStats = fs.statSync(`${hooksDir}/${SERVER_BETA_SERVICE.name}.cjs`);
    console.log(`✓ server-beta-service built (${(serverBetaStats.size / 1024).toFixed(2)} KB)`);

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
        'tree-sitter-elixir',
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
        `mcp-server.cjs contains a Bun-only ${bunRequireMatch[0]} call. This means a transitive import in src/servers/mcp-server.ts pulled in code from worker-service.ts (or another module that touches DatabaseManager/ChromaSync). The MCP server runs under Node and cannot load bun:* modules. Audit recent imports in src/servers/mcp-server.ts and src/services/worker-spawner.ts — the spawner module is intentionally lightweight and MUST NOT import anything that touches SQLite or other Bun-only modules. See PR #1645 for context.`
      );
    }
    const zodRequireRegex = /require\(\s*["']zod(?:\/[^"']*)?["']\s*\)/;
    const zodRequireMatch = mcpBundleContent.match(zodRequireRegex);
    if (zodRequireMatch) {
      throw new Error(
        `mcp-server.cjs contains external ${zodRequireMatch[0]}. Claude Desktop can launch this bundle without plugin node_modules available, so Zod must be bundled into the MCP server.`
      );
    }

    const MCP_SERVER_MAX_BYTES = 600 * 1024;
    if (mcpServerStats.size > MCP_SERVER_MAX_BYTES) {
      throw new Error(
        `mcp-server.cjs is ${(mcpServerStats.size / 1024).toFixed(2)} KB, exceeding the ${(MCP_SERVER_MAX_BYTES / 1024).toFixed(0)} KB budget. This usually means a transitive import pulled worker-service.ts (or another heavy module) into the MCP bundle. The MCP server is supposed to be a thin HTTP wrapper — audit recent imports in src/servers/mcp-server.ts and src/services/worker-spawner.ts. See PR #1645 for context on why this guardrail exists.`
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

    console.log('\n📋 Copying onboarding explainer to plugin tree...');
    const onboardingExplainerSrc = 'src/services/worker/onboarding-explainer.md';
    const onboardingExplainerDst = 'plugin/skills/how-it-works/onboarding-explainer.md';
    if (!fs.existsSync(onboardingExplainerSrc)) {
      throw new Error(`Missing onboarding explainer source: ${onboardingExplainerSrc}`);
    }
    fs.mkdirSync(path.dirname(onboardingExplainerDst), { recursive: true });
    fs.copyFileSync(onboardingExplainerSrc, onboardingExplainerDst);
    console.log(`✓ Copied ${onboardingExplainerSrc} → ${onboardingExplainerDst}`);

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
      'plugin/.claude-plugin/plugin.json',
      'plugin/.codex-plugin/plugin.json',
      'plugin/.mcp.json',
      '.codex-plugin/plugin.json',
      '.mcp.json',
      '.agents/plugins/marketplace.json',
    ];
    for (const filePath of requiredDistributionFiles) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Missing required distribution file: ${filePath}`);
      }
    }
    const codexHooks = JSON.parse(fs.readFileSync('plugin/hooks/codex-hooks.json', 'utf-8'));
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
    const rootMcp = JSON.parse(fs.readFileSync('.mcp.json', 'utf-8'));
    const bundledMcp = JSON.parse(fs.readFileSync('plugin/.mcp.json', 'utf-8'));
    if (JSON.stringify(rootMcp.mcpServers?.['mcp-search']) !== JSON.stringify(bundledMcp.mcpServers?.['mcp-search'])) {
      throw new Error('.mcp.json and plugin/.mcp.json mcp-search launchers must stay in sync');
    }
    const mcpSearchCommand = bundledMcp.mcpServers?.['mcp-search']?.args?.join(' ') ?? '';
    if (!mcpSearchCommand.includes('.codex/plugins/cache/claude-mem-local/claude-mem')) {
      throw new Error('plugin/.mcp.json mcp-search launcher must include Codex cache fallback for hosts that do not inject PLUGIN_ROOT');
    }
    if (!mcpSearchCommand.includes('plugins/cache/thedotmack/claude-mem')) {
      throw new Error('plugin/.mcp.json mcp-search launcher must include Claude cache fallback for hosts that do not inject PLUGIN_ROOT');
    }
    console.log('✓ All required distribution files present');

    console.log('\n✅ All build targets compiled successfully!');
    console.log(`   Output: ${hooksDir}/`);
    console.log(`   - Worker: worker-service.cjs`);
    console.log(`   - Server beta: server-beta-service.cjs`);
    console.log(`   - MCP Server: mcp-server.cjs`);
    console.log(`   - Context Generator: context-generator.cjs`);
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
