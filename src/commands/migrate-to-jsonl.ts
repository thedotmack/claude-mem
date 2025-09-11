#!/usr/bin/env node

/**
 * One-time migration script to convert claude-mem-index.md to claude-mem-index.jsonl
 */

import fs from 'fs';
import path from 'path';
import { PathDiscovery } from '../services/path-discovery.js';

export function migrateToJSONL(): void {
  const pathDiscovery = PathDiscovery.getInstance();
  const oldIndexPath = path.join(pathDiscovery.getDataDirectory(), 'claude-mem-index.md');
  const newIndexPath = pathDiscovery.getIndexPath();
  
  // Check if old index exists
  if (!fs.existsSync(oldIndexPath)) {
    console.log('No markdown index found to migrate');
    return;
  }
  
  // Check if new index already exists
  if (fs.existsSync(newIndexPath)) {
    console.log('JSONL index already exists, skipping migration');
    return;
  }
  
  console.log('Starting migration from MD to JSONL...');
  
  const content = fs.readFileSync(oldIndexPath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  
  const jsonlLines: string[] = [];
  let currentSessionId = '';
  let currentSessionTimestamp = '';
  
  for (const line of lines) {
    // Parse session headers: # Session: <id> [<timestamp>]
    const sessionMatch = line.match(/^# Session:\s*([^\[]+)(?:\s*\[([^\]]+)\])?/);
    if (sessionMatch) {
      currentSessionId = sessionMatch[1].trim();
      currentSessionTimestamp = sessionMatch[2]?.trim() || new Date().toISOString();
      
      // Extract project from session ID (assuming format like <project>_<uuid>)
      const projectMatch = currentSessionId.match(/^([^_]+)_/);
      const project = projectMatch ? projectMatch[1] : 'unknown';
      
      jsonlLines.push(JSON.stringify({
        type: 'session',
        session_id: currentSessionId,
        timestamp: currentSessionTimestamp,
        project
      }));
      continue;
    }
    
    // Parse overviews: **Overview:** <text>
    const overviewMatch = line.match(/^\*\*Overview:\*\*\s*(.+)/);
    if (overviewMatch) {
      const overviewText = overviewMatch[1].trim();
      
      // Extract project from current session ID
      const projectMatch = currentSessionId.match(/^([^_]+)_/);
      const project = projectMatch ? projectMatch[1] : 'unknown';
      
      jsonlLines.push(JSON.stringify({
        type: 'overview',
        content: overviewText,
        session_id: currentSessionId,
        project,
        timestamp: currentSessionTimestamp
      }));
      continue;
    }
    
    // Skip certain lines
    if (line.startsWith('# NO SUMMARIES EXTRACTED')) {
      continue;
    }
    
    // Parse memory entries (pipe-separated)
    if (line.includes(' | ')) {
      const parts = line.split(' | ').map(p => p.trim());
      
      if (parts.length >= 3) {
        const [text, document_id, keywords, timestamp, archive] = parts;
        
        // Extract project from document_id (format: <project>_<session>_<number>)
        const projectMatch = document_id?.match(/^([^_]+)_/);
        const project = projectMatch ? projectMatch[1] : 'unknown';
        
        jsonlLines.push(JSON.stringify({
          type: 'memory',
          text,
          document_id: document_id || `${currentSessionId}_${Date.now()}`,
          keywords: keywords || '',
          session_id: currentSessionId,
          project,
          timestamp: timestamp || currentSessionTimestamp,
          archive: archive || `${currentSessionId}.jsonl.archive`
        }));
      }
    }
  }
  
  // Write JSONL file
  fs.writeFileSync(newIndexPath, jsonlLines.join('\n') + '\n');
  
  // Backup old index
  const backupPath = oldIndexPath + '.backup';
  fs.renameSync(oldIndexPath, backupPath);
  
  console.log(`✅ Migration complete!`);
  console.log(`   - Converted ${jsonlLines.length} entries`);
  console.log(`   - New index: ${newIndexPath}`);
  console.log(`   - Backup: ${backupPath}`);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  migrateToJSONL();
}