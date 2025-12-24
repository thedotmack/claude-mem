#!/usr/bin/env node

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

async function buildViewer() {
  console.log('Building React viewer...');

  try {
    // Build React app with CSS bundling
    const result = await esbuild.build({
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
        '.ts': 'ts',
        '.css': 'css'  // Handle CSS imports (React Flow styles)
      },
      define: {
        'process.env.NODE_ENV': '"production"'
      },
      metafile: true
    });

    // Read React Flow CSS from node_modules and prepare for injection
    const reactFlowCssPath = path.join(rootDir, 'node_modules/@xyflow/react/dist/style.css');
    let reactFlowCss = '';
    if (fs.existsSync(reactFlowCssPath)) {
      reactFlowCss = fs.readFileSync(reactFlowCssPath, 'utf-8');
      console.log('  - React Flow CSS loaded from node_modules');
    } else {
      console.warn('  ⚠ React Flow CSS not found at node_modules/@xyflow/react/dist/style.css');
    }

    // Copy HTML template and inject React Flow CSS
    let htmlTemplate = fs.readFileSync(
      path.join(rootDir, 'src/ui/viewer-template.html'),
      'utf-8'
    );

    // Inject React Flow CSS before the closing </style> tag in the template
    if (reactFlowCss) {
      // Find the last </style> tag and inject before it
      const styleCloseIndex = htmlTemplate.lastIndexOf('</style>');
      if (styleCloseIndex !== -1) {
        htmlTemplate = htmlTemplate.slice(0, styleCloseIndex) +
          '\n    /* ========== React Flow Base Styles (injected at build time) ========== */\n' +
          reactFlowCss + '\n' +
          htmlTemplate.slice(styleCloseIndex);
        console.log('  - React Flow CSS injected into HTML template');
      }
    }

    fs.writeFileSync(
      path.join(rootDir, 'plugin/ui/viewer.html'),
      htmlTemplate
    );

    // Copy font assets
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

    // Copy icon SVG files
    const srcUiDir = path.join(rootDir, 'src/ui');
    const outputUiDir = path.join(rootDir, 'plugin/ui');
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
    console.log('  - plugin/ui/assets/fonts/* (font files)');
    console.log(`  - plugin/ui/icon-thick-*.svg (${iconFiles.length} icon files)`);
  } catch (error) {
    console.error('Failed to build viewer:', error);
    process.exit(1);
  }
}

buildViewer();
