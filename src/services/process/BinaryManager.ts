import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from '../../shared/paths.js';

const BIN_DIR = join(DATA_DIR, 'bin');
const VERSION_FILE = join(BIN_DIR, 'version.txt');
const GITHUB_RELEASES = 'https://github.com/thedotmack/claude-mem/releases/download';

export class BinaryManager {
  static async getExecutablePath(): Promise<string> {
    if (process.platform !== 'win32') {
      throw new Error('BinaryManager only used on Windows');
    }

    const version = this.getCurrentVersion();
    const binaryPath = join(BIN_DIR, 'worker-service.exe');

    // Check if we have correct version
    if (existsSync(binaryPath)) {
      const installed = this.getInstalledVersion();
      if (installed === version) return binaryPath;
    }

    // Download
    await this.downloadBinary(version);
    return binaryPath;
  }

  private static async downloadBinary(version: string): Promise<void> {
    const url = `${GITHUB_RELEASES}/v${version}/worker-service-v${version}-win-x64.exe`;
    console.log(`Downloading worker binary v${version}...`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Download failed: ${response.status}\n` +
        `URL: ${url}\n` +
        `Make sure the release exists with a Windows binary attached.`
      );
    }

    const buffer = await response.arrayBuffer();
    mkdirSync(BIN_DIR, { recursive: true });

    const binaryPath = join(BIN_DIR, 'worker-service.exe');
    writeFileSync(binaryPath, Buffer.from(buffer));

    // Write version file
    writeFileSync(VERSION_FILE, version);

    console.log('Download complete');
  }

  private static getCurrentVersion(): string {
    // Read from package.json in the installed plugin location
    // This ensures we get the correct version even when running from marketplace
    try {
      const packageJson = JSON.parse(
        readFileSync(join(DATA_DIR, '..', '.claude', 'plugins', 'marketplaces', 'thedotmack', 'package.json'), 'utf-8')
      );
      return packageJson.version;
    } catch {
      // Fallback to environment variable
      return process.env.npm_package_version || 'unknown';
    }
  }

  private static getInstalledVersion(): string | null {
    try {
      if (!existsSync(VERSION_FILE)) return null;
      return readFileSync(VERSION_FILE, 'utf-8').trim();
    } catch {
      return null;
    }
  }
}
