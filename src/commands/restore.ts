import { readdirSync, renameSync } from 'fs';
import { join } from 'path';
import * as p from '@clack/prompts';
import { PathDiscovery } from '../services/path-discovery.js';

export async function restore(): Promise<void> {
  const trashDir = PathDiscovery.getInstance().getTrashDirectory();
  const files = readdirSync(trashDir);
  
  if (files.length === 0) {
    console.log('Trash is empty');
    return;
  }
  
  const file = await p.select({
    message: 'Select file to restore:',
    options: files.map(f => ({ value: f, label: f }))
  });
  
  if (p.isCancel(file)) return;
  
  renameSync(join(trashDir, file), join(process.cwd(), file));
  console.log(`Restored ${file}`);
}