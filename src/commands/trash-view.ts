import { readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import * as p from '@clack/prompts';
import { PathDiscovery } from '../services/path-discovery.js';

interface TrashItem {
  originalName: string;
  trashedName: string;
  size: number;
  trashedAt: Date;
  isDirectory: boolean;
}

function parseTrashName(filename: string): { name: string; timestamp: number } {
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1) return { name: filename, timestamp: 0 };
  
  const timestamp = parseInt(filename.substring(lastDotIndex + 1));
  if (isNaN(timestamp)) return { name: filename, timestamp: 0 };
  
  return {
    name: filename.substring(0, lastDotIndex),
    timestamp
  };
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getDirectorySize(dirPath: string): number {
  let size = 0;
  const files = readdirSync(dirPath);
  
  for (const file of files) {
    const filePath = join(dirPath, file);
    const stats = statSync(filePath);
    
    if (stats.isDirectory()) {
      size += getDirectorySize(filePath);
    } else {
      size += stats.size;
    }
  }
  
  return size;
}

export async function viewTrash(): Promise<void> {
  const trashDir = PathDiscovery.getInstance().getTrashDirectory();
  
  try {
    const files = readdirSync(trashDir);
    
    if (files.length === 0) {
      p.log.info('🗑️  Trash is empty');
      return;
    }
    
    const items: TrashItem[] = files.map(file => {
      const filePath = join(trashDir, file);
      const stats = statSync(filePath);
      const { name, timestamp } = parseTrashName(file);
      
      const size = stats.isDirectory() ? getDirectorySize(filePath) : stats.size;
      
      return {
        originalName: name,
        trashedName: file,
        size,
        trashedAt: new Date(timestamp),
        isDirectory: stats.isDirectory()
      };
    });
    
    // Sort by date, newest first
    items.sort((a, b) => b.trashedAt.getTime() - a.trashedAt.getTime());
    
    // Display header
    console.log('\n🗑️  Trash Contents\n');
    console.log('─'.repeat(80));
    
    // Display items
    let totalSize = 0;
    let folderCount = 0;
    let fileCount = 0;
    
    for (const item of items) {
      totalSize += item.size;
      if (item.isDirectory) {
        folderCount++;
      } else {
        fileCount++;
      }
      
      const type = item.isDirectory ? '📁' : '📄';
      const date = item.trashedAt.toLocaleString();
      const size = formatSize(item.size);
      
      console.log(`${type} ${item.originalName}`);
      console.log(`   Size: ${size} | Trashed: ${date}`);
      console.log(`   ID: ${item.trashedName}`);
      console.log();
    }
    
    // Display summary
    console.log('─'.repeat(80));
    console.log(`Total: ${folderCount} folders, ${fileCount} files (${formatSize(totalSize)})`);
    console.log('\nTo restore files: claude-mem restore');
    console.log('To empty trash:   claude-mem trash empty');
    
  } catch (error) {
    if ((error as any).code === 'ENOENT') {
      p.log.info('🗑️  Trash is empty');
    } else {
      p.log.error('Failed to read trash directory');
      console.error(error);
    }
  }
}