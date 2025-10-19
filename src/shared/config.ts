import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// <Block> 5.1 ====================================
// Default values
const DEFAULT_PACKAGE_NAME = 'claude-mem';
// This MUST be replaced by build process with --define flag
// @ts-ignore
// For development, use fallback
const DEFAULT_PACKAGE_VERSION = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' 
  ? __DEFAULT_PACKAGE_VERSION__ 
  : '3.5.6-dev';
const DEFAULT_PACKAGE_DESCRIPTION = 'Memory compression system for Claude Code - persist context across sessions';

let packageName = DEFAULT_PACKAGE_NAME;
let packageVersion = DEFAULT_PACKAGE_VERSION;
let packageDescription = DEFAULT_PACKAGE_DESCRIPTION;
// </Block> =======================================

// Try to read package.json if it exists (for development)
// <Block> 5.2 ====================================
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const packageJsonPath = join(__dirname, '..', '..', 'package.json');
  
  // <Block> 5.2a ====================================
  if (existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    // <Block> 5.2b ====================================
    packageName = packageJson.name || DEFAULT_PACKAGE_NAME;
    packageVersion = packageJson.version || DEFAULT_PACKAGE_VERSION;
    packageDescription = packageJson.description || DEFAULT_PACKAGE_DESCRIPTION;
    // </Block> =======================================
  }
  // </Block> =======================================
} catch {
  // Use defaults if package.json can't be read
}
// </Block> =======================================

// <Block> 5.3 ====================================
// Export package configuration
export const PACKAGE_NAME = packageName;
export const PACKAGE_VERSION = packageVersion;
export const PACKAGE_DESCRIPTION = packageDescription;
// </Block> =======================================