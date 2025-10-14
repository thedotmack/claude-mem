#!/usr/bin/env node

/**
 * Build script for claude-mem
 * Bundles TypeScript source into a single minified executable
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

async function build() {
  console.log('🔨 Building claude-mem...\n');

  try {
    // Read version from package.json
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    const version = packageJson.version;
    console.log(`📌 Version: ${version}`);

    // Check if bun is installed
    try {
      await execAsync('bun --version');
      console.log('✓ Bun detected');
    } catch {
      console.error('❌ Bun is not installed. Please install it from https://bun.sh');
      process.exit(1);
    }

    // Clean dist directory
    console.log('\n📦 Cleaning dist directory...');
    if (fs.existsSync('dist')) {
      fs.rmSync('dist', { recursive: true });
    }
    fs.mkdirSync('dist', { recursive: true });
    console.log('✓ Cleaned dist directory');

    // Build with bun
    console.log('\n🔧 Bundling with Bun...');
    const buildCommand = [
      'bun build',
      'src/bin/cli.ts',
      '--target=node',
      '--outfile=dist/claude-mem.min.js',
      '--minify',
      '--external @anthropic-ai/claude-agent-sdk',
      `--define __DEFAULT_PACKAGE_VERSION__='"${version}"'`
    ].join(' ');

    const { stdout, stderr } = await execAsync(buildCommand);
    if (stdout) console.log(stdout);
    if (stderr && !stderr.includes('warn')) console.error(stderr);
    console.log('✓ Bundle created');

    // Add shebang to output
    console.log('\n📝 Adding shebang...');
    const distFile = 'dist/claude-mem.min.js';
    const content = fs.readFileSync(distFile, 'utf-8');
    if (!content.startsWith('#!/usr/bin/env node')) {
      fs.writeFileSync(distFile, `#!/usr/bin/env node\n${content}`);
    }
    console.log('✓ Shebang added');

    // Make executable
    console.log('\n🔐 Setting executable permissions...');
    fs.chmodSync(distFile, 0o755);
    console.log('✓ Made executable');

    // Check file size
    const stats = fs.statSync(distFile);
    const sizeInKB = (stats.size / 1024).toFixed(2);
    console.log(`\n✅ Build complete! (${sizeInKB} KB)`);
    console.log(`   Output: ${distFile}`);

  } catch (error) {
    console.error('\n❌ Build failed:', error.message);
    if (error.stderr) {
      console.error('\nError details:', error.stderr);
    }
    process.exit(1);
  }
}

build();
