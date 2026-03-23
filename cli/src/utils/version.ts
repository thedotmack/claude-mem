/**
 * Version utilities.
 *
 * Tries multiple resolution paths to find package.json since the bundle
 * output (dist/index.js) has a different __dirname than the source.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

let cachedVersion: string | null = null;

export function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Try: dist/../package.json, src/utils/../../package.json
    const candidates = [
      join(__dirname, '..', 'package.json'),
      join(__dirname, '..', '..', 'package.json'),
      join(process.cwd(), 'package.json'),
    ];
    for (const pkgPath of candidates) {
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'cmem-cli' || pkg.name === 'cmem') {
          cachedVersion = pkg.version;
          return cachedVersion!;
        }
      }
    }
    return '0.1.0';
  } catch {
    return '0.1.0';
  }
}
