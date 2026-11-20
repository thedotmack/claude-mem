import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Shared by the release build and contract tests: installed modules need no node_modules. */
export const PI_EXTENSION_BUILD_OPTIONS = {
  entryPoints: ['src/integrations/pi-extension/index.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  minify: true, logLevel: 'error',
  banner: { js: '/*! Pi memory design and text extraction: Copyright (c) 2026 Husni Adil Makmur. MIT: LICENSE.txt. Claude-Mem Apache-2.0: CLAUDE-MEM-LICENSE.txt and CLAUDE-MEM-NOTICE.txt. Bundled TypeBox MIT: TYPEBOX-LICENSE.txt and TYPEBOX-PROVENANCE.json. All files are beside this extension. */' },
};

export function preparePiExtensionBuild(root = SOURCE_ROOT) {
  // Snapshot every notice before the release build creates or changes output files.
  const attributionFiles = [
    ['LICENSE.txt', join(root, 'pi', 'THIRD-PARTY-LICENSE.txt')],
    ['CLAUDE-MEM-LICENSE.txt', join(root, 'LICENSE')],
    ['CLAUDE-MEM-NOTICE.txt', join(root, 'NOTICE')],
    ['TYPEBOX-LICENSE.txt', join(root, 'pi', 'TYPEBOX-LICENSE.txt')],
    ['TYPEBOX-PROVENANCE.json', join(root, 'pi', 'TYPEBOX-PROVENANCE.json')],
  ].map(([name, path]) => ({ name, contents: readFileSync(path) }));
  const expected = JSON.parse(attributionFiles.find(file => file.name === 'TYPEBOX-PROVENANCE.json').contents.toString('utf8'));
  const declared = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies?.typebox;
  const entry = createRequire(join(root, 'package.json')).resolve('typebox');
  const packageRoot = resolve(dirname(entry), '..');
  const manifestBytes = readFileSync(join(packageRoot, 'package.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const actualLicense = readFileSync(join(packageRoot, 'license'));
  const expectedLicense = attributionFiles.find(file => file.name === 'TYPEBOX-LICENSE.txt').contents;
  if (declared !== '1.1.24' || expected.name !== 'typebox' || expected.version !== declared || expected.license !== 'MIT'
      || manifest.name !== expected.name || manifest.version !== expected.version || manifest.license !== expected.license
      || entry !== join(packageRoot, expected.resolvedEntry)
      || sha256(manifestBytes) !== expected.packageJsonSha256
      || sha256(actualLicense) !== expected.licenseSha256 || !actualLicense.equals(expectedLicense)) {
    throw new Error('Resolved TypeBox does not match the pinned Pi attribution. Update the dependency pin and full notice together before building.');
  }
  // esbuild consumes this exact resolved entry, rather than resolving a second TypeBox.
  return { options: { ...PI_EXTENSION_BUILD_OPTIONS, alias: { typebox: entry } }, attributionFiles };
}

export function preflightDshAttribution(root = SOURCE_ROOT) {
  const projectLicense = readFileSync(join(root, 'LICENSE'));
  const projectNotice = readFileSync(join(root, 'NOTICE'));
  const dshLicense = readFileSync(join(root, 'dsh', 'LICENSE'));
  const dshNotice = readFileSync(join(root, 'dsh', 'NOTICE'));
  readFileSync(join(root, 'dsh', 'THIRD-PARTY-LICENSES.txt'));
  if (!dshLicense.subarray(0, projectLicense.length).equals(projectLicense) || !dshNotice.includes(projectNotice)) {
    throw new Error('DSH must carry the complete current project LICENSE and NOTICE.');
  }
}

export const DSH_PLUGIN_BUILD_OPTIONS = {
  entryPoints: ['src/integrations/dsh-plugin/index.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  minify: true, logLevel: 'error',
  banner: { js: 'import { createRequire as __cmCreateRequire } from "node:module"; const require = __cmCreateRequire(import.meta.url);' },
};
