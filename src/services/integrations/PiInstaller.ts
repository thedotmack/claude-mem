import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';
import type { OwnedFile } from '../../shared/owned-file-install.js';
import { LIBRARY_GROUPS } from '../wire-gateway/library/agent-library-targets.js';
import { applyLibraryForInstaller, removeLibraryForInstaller } from '../wire-gateway/library/library-runtime.js';
import type { OwnedFileItem } from '../wire-gateway/library/types.js';

const PI_CAPTURE_GUIDANCE =
  'Automatic memory capture is not verified by installation or status. Pi 0.79.6 provides manual recall only. ' +
  'Capture compatibility is source-reviewed for Pi 1.0.2 and 1.0.4; other or unknown versions need a compatibility check. ' +
  'Check your Pi version and update Pi if needed: https://github.com/thedotmack/claude-mem/blob/main/docs/pi-native-capture.md';

const PI_OWNED_FILES = ['index.js', 'package.json', 'LICENSE.txt', 'CLAUDE-MEM-LICENSE.txt', 'CLAUDE-MEM-NOTICE.txt', 'TYPEBOX-LICENSE.txt', 'TYPEBOX-PROVENANCE.json'];

export function piExtensionDirectory(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'extensions', 'claude-mem');
}
export function piExtensionPath(): string { return join(piExtensionDirectory(), 'index.js'); }

export function findPiExtensionSource(): string | null {
  const roots = [MARKETPLACE_ROOT];
  if (process.env.CLAUDE_MEM_DEV_HOOK_SOURCE === '1') roots.push(process.cwd());
  for (const root of roots) {
    const file = join(root, 'dist', 'pi-extension', 'index.js');
    if (existsSync(file)) return file;
  }
  return null;
}

function piOwnedInputs(source: string): OwnedFile[] {
  const bundle = readFileSync(source);
  const root = resolve(dirname(source), '..', '..');
  const attributions = [
    ['LICENSE.txt', join(root, 'pi', 'THIRD-PARTY-LICENSE.txt')],
    ['CLAUDE-MEM-LICENSE.txt', join(root, 'LICENSE')],
    ['CLAUDE-MEM-NOTICE.txt', join(root, 'NOTICE')],
    ['TYPEBOX-LICENSE.txt', join(root, 'pi', 'TYPEBOX-LICENSE.txt')],
    ['TYPEBOX-PROVENANCE.json', join(root, 'pi', 'TYPEBOX-PROVENANCE.json')],
  ].map(([name, path]) => ({ name, contents: readFileSync(path) }));
  // The release build places the same preflighted texts beside the generated bundle.
  for (const file of attributions) {
    if (!readFileSync(join(dirname(source), file.name)).equals(file.contents)) throw new Error('Pi bundle attribution does not match its package source: ' + file.name);
  }
  const typeboxLicense = attributions.find(file => file.name === 'TYPEBOX-LICENSE.txt')!;
  const provenance = JSON.parse(attributions.find(file => file.name === 'TYPEBOX-PROVENANCE.json')!.contents.toString('utf8'));
  if (provenance.name !== 'typebox' || provenance.version !== '1.1.24' || provenance.license !== 'MIT'
      || provenance.licenseSha256 !== createHash('sha256').update(typeboxLicense.contents).digest('hex')) {
    throw new Error('Invalid Pi TypeBox attribution provenance.');
  }
  return [
    { name: 'index.js', contents: bundle },
    { name: 'package.json', contents: Buffer.from(JSON.stringify({ name: '@claude-mem/pi', private: true, type: 'module' }) + '\n') },
    ...attributions,
  ];
}

/** The extension's files as Library bundle items; the extension folder is claude-mem's own. */
function piBundleItems(files: OwnedFile[]): OwnedFileItem[] {
  return files.map((file) => ({
    kind: 'bundle', id: `bundle:${file.name}`, group: LIBRARY_GROUPS.bundle, place: 'file',
    path: join(piExtensionDirectory(), file.name), contents: file.contents, bundleRoot: piExtensionDirectory(),
  }));
}

export function installPiExtension(): number {
  const source = findPiExtensionSource();
  if (!source) {
    console.error('Pi extension bundle is missing. Re-run npx claude-mem install after restoring the package build.');
    return 1;
  }
  try {
    // Finish every source read and provenance check before destination mutation;
    // the Library then writes the set as one group (all or none).
    applyLibraryForInstaller({ agentId: 'pi', items: piBundleItems(piOwnedInputs(source)), ownedGroups: [LIBRARY_GROUPS.bundle] });
    console.log('Pi extension files installed: ' + piExtensionPath() + '. Restart Pi to load the memory tools.');
    console.log(PI_CAPTURE_GUIDANCE);
    return 0;
  } catch (error) {
    console.error('Could not install Pi memory: ' + String(error));
    return 1;
  }
}
export function uninstallPiExtension(): number {
  try {
    // The owned names also cover an install from before the Library record.
    removeLibraryForInstaller({ agentId: 'pi', items: piBundleItems(PI_OWNED_FILES.map((name) => ({ name, contents: Buffer.alloc(0) }))) });
    return 0;
  }
  catch (error) { console.error('Could not uninstall Pi memory: ' + String(error)); return 1; }
}
export function piExtensionStatus(): number {
  const installed = existsSync(piExtensionPath());
  console.log('Pi extension files: ' + (installed ? 'installed at ' + piExtensionPath() : 'not installed'));
  console.log(PI_CAPTURE_GUIDANCE);
  return installed ? 0 : 1;
}
