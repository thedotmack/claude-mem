import { OptionValues } from 'commander';
import fs from 'fs';
import path from 'path';
import { PathDiscovery } from '../services/path-discovery.js';
import { createStores } from '../services/sqlite/index.js';

type CheckStatus = 'pass' | 'fail' | 'warn';

interface CheckResult {
  name: string;
  status: CheckStatus;
  details?: string;
}

function printCheck(result: CheckResult): void {
  const icon =
    result.status === 'pass' ? '✅' : result.status === 'warn' ? '⚠️ ' : '❌';
  const message = result.details ? `${result.name}: ${result.details}` : result.name;
  console.log(`${icon} ${message}`);
}

export async function doctor(options: OptionValues = {}): Promise<void> {
  const discovery = PathDiscovery.getInstance();
  const checks: CheckResult[] = [];

  // Data directory
  try {
    const dataDir = discovery.getDataDirectory();
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      checks.push({ name: `Data directory created at ${dataDir}`, status: 'warn' });
    } else {
      const stats = fs.statSync(dataDir);
      let writable = false;
      try {
        fs.accessSync(dataDir, fs.constants.W_OK);
        writable = true;
      } catch {}
      checks.push({
        name: `Data directory ${dataDir}`,
        status: stats.isDirectory() && writable ? 'pass' : 'fail',
        details: stats.isDirectory() && writable ? 'accessible' : 'not writable'
      });
    }
  } catch (error: any) {
    checks.push({
      name: 'Data directory',
      status: 'fail',
      details: error?.message || String(error)
    });
  }

  // SQLite connectivity
  let stores; // reuse for queue check
  try {
    stores = await createStores();
    const sessionCount = stores.sessions.count();
    checks.push({
      name: 'SQLite database',
      status: 'pass',
      details: `${sessionCount} session${sessionCount === 1 ? '' : 's'} present`
    });
  } catch (error: any) {
    checks.push({
      name: 'SQLite database',
      status: 'fail',
      details: error?.message || String(error)
    });
  }

  // Chroma connectivity
  try {
    const chromaDir = discovery.getChromaDirectory();
    const chromaExists = fs.existsSync(chromaDir);
    checks.push({
      name: 'Chroma vector store',
      status: chromaExists ? 'pass' : 'warn',
      details: chromaExists ? `data dir ${path.resolve(chromaDir)}` : 'Not yet initialized'
    });
  } catch (error: any) {
    checks.push({
      name: 'Chroma vector store',
      status: 'warn',
      details: error?.message || 'Unable to check Chroma directory'
    });
  }

  if (options.json) {
    console.log(JSON.stringify({ checks }, null, 2));
  } else {
    console.log('claude-mem doctor');
    console.log('=================');
    checks.forEach(printCheck);
  }
}
