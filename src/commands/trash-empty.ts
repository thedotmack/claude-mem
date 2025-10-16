import { rmSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import * as p from '@clack/prompts';
import * as paths from '../shared/paths.js';

export async function emptyTrash(options: { force?: boolean } = {}): Promise<void> {
  const trashDir = paths.TRASH_DIR;
  
  // Check if trash directory exists
  if (!existsSync(trashDir)) {
    p.log.info('🗑️  Trash is already empty');
    return;
  }
  
  try {
    const files = readdirSync(trashDir);
    
    if (files.length === 0) {
      p.log.info('🗑️  Trash is already empty');
      return;
    }
    
    // Count items
    let folderCount = 0;
    let fileCount = 0;
    
    for (const file of files) {
      const filePath = join(trashDir, file);
      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        folderCount++;
      } else {
        fileCount++;
      }
    }
    
    // Confirm deletion unless --force flag is used
    if (!options.force) {
      const confirm = await p.confirm({
        message: `Permanently delete ${folderCount} folders and ${fileCount} files from trash?`,
        initialValue: false
      });
      
      if (p.isCancel(confirm) || !confirm) {
        p.log.info('Cancelled - trash not emptied');
        return;
      }
    }
    
    // Delete all files in trash
    const s = p.spinner();
    s.start('Emptying trash...');
    
    for (const file of files) {
      const filePath = join(trashDir, file);
      rmSync(filePath, { recursive: true, force: true });
    }
    
    s.stop(`🗑️  Trash emptied - permanently deleted ${folderCount} folders and ${fileCount} files`);
    
  } catch (error) {
    p.log.error('Failed to empty trash');
    console.error(error);
    process.exit(1);
  }
}