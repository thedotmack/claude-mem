#!/usr/bin/env node

/**
 * Build script for claude-mem hooks
 * Bundles TypeScript hooks into individual standalone executables using esbuild
 */

import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKER_SERVICE = {
  name: 'worker-service',
  source: 'src/services/worker-service.ts'
};

const MCP_SERVER = {
  name: 'mcp-server',
  source: 'src/servers/mcp-server.ts'
};

const CONTEXT_GENERATOR = {
  name: 'context-generator',
  source: 'src/services/context-generator.ts'
};

/**
 * Strip hardcoded __dirname/__filename from bundled CJS output.
 *
 * When esbuild converts ESM TypeScript source to CJS format, it inlines
 * __dirname and __filename as static strings based on the SOURCE file paths
 * at build time. These `var __dirname = "/build/machine/path/..."` declarations
 * shadow the runtime's native __dirname (provided by Bun/Node's CJS module
 * wrapper), causing path resolution to fail on end-user machines.
 *
 * This post-build step removes those hardcoded assignments so the runtime
 * globals are used instead.
 *
 * See: https://github.com/thedotmack/claude-mem/issues/1410
 */
function stripHardcodedDirname(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  const before = content.length;

  // Match both double-quoted and single-quoted string literals.
  // esbuild currently emits double quotes, but single quotes are handled
  // defensively in case future versions change quoting style.
  const str = `(?:"[^"]*"|'[^']*')`;

  for (const id of ['__dirname', '__filename']) {
    // Remove `var <id> = "...", rest` → `var rest`
    content = content.replace(new RegExp(`\\bvar ${id}\\s*=\\s*${str},\\s*`, 'g'), 'var ');
    // Remove standalone `var <id> = "...";`
    content = content.replace(new RegExp(`\\bvar ${id}\\s*=\\s*${str};\\s*`, 'g'), '');
    // Remove `, <id> = "..."` from mid/end of var declarations
    content = content.replace(new RegExp(`,\\s*${id}\\s*=\\s*${str}`, 'g'), '');
  }

  // Clean up dangling `var ;` left when __dirname was the sole declarator
  content = content.replace(/\bvar\s*;/g, '');

  const removed = before - content.length;
  if (removed > 0) {
    fs.writeFileSync(filePath, content);
    console.log(`  ✓ Stripped hardcoded __dirname/__filename paths (${removed} bytes)`);
  }
}

async function buildHooks() {
  console.log('🔨 Building claude-mem hooks and worker service...\n');

  try {
    // Read version from package.json
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    const version = packageJson.version;
    console.log(`📌 Version: ${version}`);

    // Create output directories
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

    // Generate plugin/package.json for cache directory dependency installation
    // Note: bun:sqlite is a Bun built-in, no external dependencies needed for SQLite
    console.log('\n📦 Generating plugin package.json...');
    const pluginPackageJson = {
      name: 'claude-mem-plugin',
      version: version,
      private: true,
      description: 'Runtime dependencies for claude-mem bundled hooks',
      type: 'module',
      dependencies: {
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
      },
      engines: {
        node: '>=18.0.0',
        bun: '>=1.0.0'
      }
    };
    fs.writeFileSync('plugin/package.json', JSON.stringify(pluginPackageJson, null, 2) + '\n');
    console.log('✓ plugin/package.json generated');

    // Build React viewer
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

    // Build worker service
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
        // Optional chromadb embedding providers
        'cohere-ai',
        'ollama',
        // Default embedding function with native binaries
        '@chroma-core/default-embed',
        'onnxruntime-node'
      ],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      },
      banner: {
        js: [
          '#!/usr/bin/env bun',
          'var __filename = require("node:url").fileURLToPath(import.meta.url);',
          'var __dirname = require("node:path").dirname(__filename);'
        ].join('\n')
      }
    });

    // Fix hardcoded __dirname/__filename in bundled output (#1410)
    stripHardcodedDirname(`${hooksDir}/${WORKER_SERVICE.name}.cjs`);

    // Make worker service executable
    fs.chmodSync(`${hooksDir}/${WORKER_SERVICE.name}.cjs`, 0o755);
    const workerStats = fs.statSync(`${hooksDir}/${WORKER_SERVICE.name}.cjs`);
    console.log(`✓ worker-service built (${(workerStats.size / 1024).toFixed(2)} KB)`);

    // Build MCP server
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
      ],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      },
      banner: {
        js: '#!/usr/bin/env node'
      }
    });

    // Fix hardcoded __dirname/__filename in bundled output (#1410)
    stripHardcodedDirname(`${hooksDir}/${MCP_SERVER.name}.cjs`);

    // Make MCP server executable
    fs.chmodSync(`${hooksDir}/${MCP_SERVER.name}.cjs`, 0o755);
    const mcpServerStats = fs.statSync(`${hooksDir}/${MCP_SERVER.name}.cjs`);
    console.log(`✓ mcp-server built (${(mcpServerStats.size / 1024).toFixed(2)} KB)`);

    // Build context generator
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
      external: ['bun:sqlite'],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      },
      // No banner needed: CJS files under Node.js have __dirname/__filename natively
    });

    // Fix hardcoded __dirname/__filename in bundled output (#1410)
    stripHardcodedDirname(`${hooksDir}/${CONTEXT_GENERATOR.name}.cjs`);

    const contextGenStats = fs.statSync(`${hooksDir}/${CONTEXT_GENERATOR.name}.cjs`);
    console.log(`✓ context-generator built (${(contextGenStats.size / 1024).toFixed(2)} KB)`);

    // Build NPX CLI (pure Node.js — no Bun dependency)
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
      ],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      },
    });

    // Make NPX CLI executable
    fs.chmodSync(`${npxCliOutDir}/index.js`, 0o755);
    const npxCliStats = fs.statSync(`${npxCliOutDir}/index.js`);
    console.log(`✓ npx-cli built (${(npxCliStats.size / 1024).toFixed(2)} KB)`);

    // Build OpenClaw plugin (self-contained, only Node builtins external)
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

    // Build OpenCode plugin (self-contained, Node.js ESM — Bun-compatible)
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

    // Verify critical distribution files exist (skills are source files, not build outputs)
    console.log('\n📋 Verifying distribution files...');
    const requiredDistributionFiles = [
      'plugin/skills/mem-search/SKILL.md',
      'plugin/skills/smart-explore/SKILL.md',
      'plugin/hooks/hooks.json',
      'plugin/.claude-plugin/plugin.json',
    ];
    for (const filePath of requiredDistributionFiles) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Missing required distribution file: ${filePath}`);
      }
    }
    console.log('✓ All required distribution files present');

    console.log('\n✅ All build targets compiled successfully!');
    console.log(`   Output: ${hooksDir}/`);
    console.log(`   - Worker: worker-service.cjs`);
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
