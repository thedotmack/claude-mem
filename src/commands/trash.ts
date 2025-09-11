import { renameSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { glob } from 'glob';
import { PathDiscovery } from '../services/path-discovery.js';

interface TrashOptions {
  force?: boolean;
  recursive?: boolean;
}

export async function trash(filePaths: string | string[], options: TrashOptions = {}): Promise<void> {
  const trashDir = PathDiscovery.getInstance().getTrashDirectory();
  if (!existsSync(trashDir)) mkdirSync(trashDir, { recursive: true });
  
  // Handle single string or array of paths
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  
  for (const filePath of paths) {
    // Handle glob patterns
    const expandedPaths = await glob(filePath);
    const actualPaths = expandedPaths.length > 0 ? expandedPaths : [filePath];
    
    for (const actualPath of actualPaths) {
      try {
        // Check if file exists
        if (!existsSync(actualPath)) {
          if (!options.force) {
            console.error(`trash: ${actualPath}: No such file or directory`);
            continue;
          }
          // With -f, silently skip missing files
          continue;
        }
        
        // Check if it's a directory and we need recursive
        const stats = statSync(actualPath);
        if (stats.isDirectory() && !options.recursive) {
          if (!options.force) {
            console.error(`trash: ${actualPath}: is a directory`);
            continue;
          }
        }
        
        // Generate unique destination name to avoid conflicts
        const fileName = basename(actualPath);
        const timestamp = Date.now();
        const destination = join(trashDir, `${fileName}.${timestamp}`);
        
        renameSync(actualPath, destination);
        console.log(`Moved ${fileName} to trash`);
        
      } catch (error) {
        if (!options.force) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`trash: ${actualPath}: ${errorMessage}`);
        }
      }
    }
  }
}