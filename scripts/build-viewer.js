#!/usr/bin/env node

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

async function buildViewer() {
  console.log('Building React viewer...');

  try {
    await esbuild.build({
      entryPoints: [path.join(rootDir, 'src/ui/viewer/index.tsx')],
      bundle: true,
      minify: true,
      sourcemap: false,
      target: ['es2020'],
      format: 'iife',
      outfile: path.join(rootDir, 'plugin/ui/viewer-bundle.js'),
      jsx: 'automatic',
      loader: {
        '.tsx': 'tsx',
        '.ts': 'ts'
      },
      define: {
        'process.env.NODE_ENV': '"production"'
      }
    });

    const htmlTemplate = fs.readFileSync(
      path.join(rootDir, 'src/ui/viewer-template.html'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(rootDir, 'plugin/ui/viewer.html'),
      htmlTemplate
    );

    // Observation TV is a standalone page with no bundle — copy it verbatim.
    fs.copyFileSync(
      path.join(rootDir, 'src/ui/tv.html'),
      path.join(rootDir, 'plugin/ui/tv.html')
    );

    const fontsDir = path.join(rootDir, 'src/ui/viewer/assets/fonts');
    const outputFontsDir = path.join(rootDir, 'plugin/ui/assets/fonts');

    if (fs.existsSync(fontsDir)) {
      fs.mkdirSync(outputFontsDir, { recursive: true });
      const fontFiles = fs.readdirSync(fontsDir);
      for (const file of fontFiles) {
        fs.copyFileSync(
          path.join(fontsDir, file),
          path.join(outputFontsDir, file)
        );
      }
    }

    const srcUiDir = path.join(rootDir, 'src/ui');
    const outputUiDir = path.join(rootDir, 'plugin/ui');
    // The My Work React app (src/ui/my-work) has its own package.json and lockfile; Vite writes it
    // to plugin/ui/work-view with fonts bundled locally, so an offline install renders immediately.
    // execFileSync throws on a non-zero exit, which fails the build. Windows needs a shell to run npm.cmd.
    const myWorkAppDir = path.join(srcUiDir, 'my-work');
    const npmRunOptions = { cwd: myWorkAppDir, stdio: 'inherit', shell: process.platform === 'win32' };
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], npmRunOptions);
    execFileSync('npm', ['run', 'build'], npmRunOptions);
    const iconFiles = fs.readdirSync(srcUiDir).filter(file => file.startsWith('icon-thick-') && file.endsWith('.svg'));
    for (const file of iconFiles) {
      fs.copyFileSync(
        path.join(srcUiDir, file),
        path.join(outputUiDir, file)
      );
    }

    console.log('✓ React viewer built successfully');
    console.log('  - plugin/ui/viewer-bundle.js');
    console.log('  - plugin/ui/viewer.html (from viewer-template.html)');
    console.log('  - plugin/ui/tv.html (from src/ui/tv.html)');
    console.log('  - plugin/ui/work-view/* (My Work app, Vite build of src/ui/my-work)');
    console.log('  - plugin/ui/assets/fonts/* (font files)');
    console.log(`  - plugin/ui/icon-thick-*.svg (${iconFiles.length} icon files)`);
  } catch (error) {
    console.error('Failed to build viewer:', error);
    process.exit(1);
  }
}

buildViewer();
