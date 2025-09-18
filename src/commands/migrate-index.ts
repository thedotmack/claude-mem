import { OptionValues } from 'commander';
import fs from 'fs';
import path from 'path';
import { PathDiscovery } from '../services/path-discovery.js';
import { 
  createStores, 
  SessionInput, 
  MemoryInput, 
  OverviewInput, 
  DiagnosticInput, 
  normalizeTimestamp 
} from '../services/sqlite/index.js';

interface MigrationStats {
  totalLines: number;
  skippedLines: number;
  invalidJson: number;
  sessionsCreated: number;
  memoriesCreated: number;
  overviewsCreated: number;
  diagnosticsCreated: number;
  orphanedOverviews: number;
  orphanedMemories: number;
}

/**
 * Migrate claude-mem index from JSONL to SQLite
 */
export async function migrateIndex(options: OptionValues = {}): Promise<void> {
  const pathDiscovery = PathDiscovery.getInstance();
  const indexPath = pathDiscovery.getIndexPath();
  const backupPath = `${indexPath}.backup-${Date.now()}`;

  console.log('🔄 Starting JSONL to SQLite migration...');
  console.log(`📁 Index file: ${indexPath}`);

  // Check if JSONL file exists
  if (!fs.existsSync(indexPath)) {
    console.log('ℹ️  No JSONL index file found - nothing to migrate');
    return;
  }

  try {
    // Initialize SQLite database and stores
    console.log('🏗️  Initializing SQLite database...');
    const stores = await createStores();
    
    // Check if we already have data in SQLite
    const existingSessions = stores.sessions.count();
    if (existingSessions > 0 && !options.force) {
      console.log(`⚠️  SQLite database already contains ${existingSessions} sessions.`);
      console.log('   Use --force to migrate anyway (will skip duplicates)');
      return;
    }

    // Create backup of JSONL file
    if (!options.keepJsonl) {
      console.log(`💾 Creating backup: ${path.basename(backupPath)}`);
      fs.copyFileSync(indexPath, backupPath);
    }

    // Read and parse JSONL file
    console.log('📖 Reading JSONL index file...');
    const content = fs.readFileSync(indexPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    const stats: MigrationStats = {
      totalLines: lines.length,
      skippedLines: 0,
      invalidJson: 0,
      sessionsCreated: 0,
      memoriesCreated: 0,
      overviewsCreated: 0,
      diagnosticsCreated: 0,
      orphanedOverviews: 0,
      orphanedMemories: 0
    };

    console.log(`📝 Processing ${stats.totalLines} lines...`);

    // Parse all lines first
    const records: any[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      try {
        // Skip lines that don't look like JSON
        if (!line.trim().startsWith('{')) {
          stats.skippedLines++;
          continue;
        }
        
        const record = JSON.parse(line);
        if (record && typeof record === 'object') {
          records.push({ ...record, _lineNumber: i + 1 });
        } else {
          stats.skippedLines++;
        }
      } catch (error) {
        stats.invalidJson++;
        console.warn(`⚠️  Invalid JSON at line ${i + 1}: ${line.substring(0, 50)}...`);
      }
    }

    console.log(`✅ Parsed ${records.length} valid records`);

    // Group records by type
    const sessions = records.filter(r => r.type === 'session');
    const memories = records.filter(r => r.type === 'memory');
    const overviews = records.filter(r => r.type === 'overview');
    const diagnostics = records.filter(r => r.type === 'diagnostic');
    const unknown = records.filter(r => !['session', 'memory', 'overview', 'diagnostic'].includes(r.type));

    if (unknown.length > 0) {
      console.log(`⚠️  Found ${unknown.length} records with unknown types - will skip`);
      stats.skippedLines += unknown.length;
    }

    // Create session tracking
    const sessionIds = new Set(sessions.map(s => s.session_id));
    const orphanedSessionIds = new Set();

    // Migrate sessions first
    console.log('💾 Migrating sessions...');
    for (const sessionData of sessions) {
      try {
        const { isoString } = normalizeTimestamp(sessionData.timestamp);
        
        const sessionInput: SessionInput = {
          session_id: sessionData.session_id,
          project: sessionData.project || 'unknown',
          created_at: isoString,
          source: 'legacy-jsonl'
        };

        // Skip if session already exists (when using --force)
        if (!stores.sessions.has(sessionInput.session_id)) {
          stores.sessions.create(sessionInput);
          stats.sessionsCreated++;
        }
      } catch (error) {
        console.warn(`⚠️  Failed to migrate session ${sessionData.session_id}: ${error}`);
      }
    }

    // Migrate memories
    console.log('🧠 Migrating memories...');
    for (const memoryData of memories) {
      try {
        const { isoString } = normalizeTimestamp(memoryData.timestamp);
        
        // Check if session exists, create orphaned session if needed
        if (!sessionIds.has(memoryData.session_id)) {
          if (!orphanedSessionIds.has(memoryData.session_id)) {
            orphanedSessionIds.add(memoryData.session_id);
            
            const orphanedSession: SessionInput = {
              session_id: memoryData.session_id,
              project: memoryData.project || 'unknown',
              created_at: isoString,
              source: 'legacy-jsonl'
            };

            if (!stores.sessions.has(orphanedSession.session_id)) {
              stores.sessions.create(orphanedSession);
              stats.sessionsCreated++;
              stats.orphanedMemories++;
            }
          }
        }

        const memoryInput: MemoryInput = {
          session_id: memoryData.session_id,
          text: memoryData.text || '',
          document_id: memoryData.document_id,
          keywords: memoryData.keywords,
          created_at: isoString,
          project: memoryData.project || 'unknown',
          archive_basename: memoryData.archive,
          origin: 'transcript'
        };

        // Skip duplicate document_ids
        if (!memoryInput.document_id || !stores.memories.hasDocumentId(memoryInput.document_id)) {
          stores.memories.create(memoryInput);
          stats.memoriesCreated++;
        }
      } catch (error) {
        console.warn(`⚠️  Failed to migrate memory ${memoryData.document_id}: ${error}`);
      }
    }

    // Migrate overviews
    console.log('📋 Migrating overviews...');
    for (const overviewData of overviews) {
      try {
        const { isoString } = normalizeTimestamp(overviewData.timestamp);
        
        // Check if session exists, create orphaned session if needed
        if (!sessionIds.has(overviewData.session_id)) {
          if (!orphanedSessionIds.has(overviewData.session_id)) {
            orphanedSessionIds.add(overviewData.session_id);
            
            const orphanedSession: SessionInput = {
              session_id: overviewData.session_id,
              project: overviewData.project || 'unknown',
              created_at: isoString,
              source: 'legacy-jsonl'
            };

            if (!stores.sessions.has(orphanedSession.session_id)) {
              stores.sessions.create(orphanedSession);
              stats.sessionsCreated++;
              stats.orphanedOverviews++;
            }
          }
        }

        const overviewInput: OverviewInput = {
          session_id: overviewData.session_id,
          content: overviewData.content || '',
          created_at: isoString,
          project: overviewData.project || 'unknown',
          origin: 'claude'
        };

        stores.overviews.upsert(overviewInput);
        stats.overviewsCreated++;
      } catch (error) {
        console.warn(`⚠️  Failed to migrate overview ${overviewData.session_id}: ${error}`);
      }
    }

    // Migrate diagnostics
    console.log('🩺 Migrating diagnostics...');
    for (const diagnosticData of diagnostics) {
      try {
        const { isoString } = normalizeTimestamp(diagnosticData.timestamp);
        
        const diagnosticInput: DiagnosticInput = {
          session_id: diagnosticData.session_id,
          message: diagnosticData.message || '',
          severity: 'warn',
          created_at: isoString,
          project: diagnosticData.project || 'unknown',
          origin: 'compressor'
        };

        stores.diagnostics.create(diagnosticInput);
        stats.diagnosticsCreated++;
      } catch (error) {
        console.warn(`⚠️  Failed to migrate diagnostic: ${error}`);
      }
    }

    // Print migration summary
    console.log('\n✅ Migration completed successfully!');
    console.log('\n📊 Migration Summary:');
    console.log(`   Total lines processed: ${stats.totalLines}`);
    console.log(`   Skipped lines: ${stats.skippedLines}`);
    console.log(`   Invalid JSON lines: ${stats.invalidJson}`);
    console.log(`   Sessions created: ${stats.sessionsCreated}`);
    console.log(`   Memories created: ${stats.memoriesCreated}`);
    console.log(`   Overviews created: ${stats.overviewsCreated}`);
    console.log(`   Diagnostics created: ${stats.diagnosticsCreated}`);
    
    if (stats.orphanedOverviews > 0 || stats.orphanedMemories > 0) {
      console.log(`   Orphaned records (sessions synthesized): ${stats.orphanedOverviews + stats.orphanedMemories}`);
    }

    // Archive or keep JSONL file
    if (options.keepJsonl) {
      console.log(`\n💾 Original JSONL file preserved: ${indexPath}`);
      console.log(`   SQLite database is now the primary index`);
    } else {
      const archiveDir = path.join(pathDiscovery.getDataDirectory(), 'archive', 'legacy');
      fs.mkdirSync(archiveDir, { recursive: true });
      
      const archivedPath = path.join(archiveDir, `claude-mem-index-${Date.now()}.jsonl`);
      fs.renameSync(indexPath, archivedPath);
      
      console.log(`\n📦 Original JSONL file archived: ${path.basename(archivedPath)}`);
      console.log(`   Backup available at: ${path.basename(backupPath)}`);
    }

    console.log('\n🎉 Migration complete! You can now use claude-mem with SQLite backend.');
    console.log('   Run `claude-mem load-context` to verify the migration worked.');

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    
    // Restore backup if we created one
    if (fs.existsSync(backupPath) && !fs.existsSync(indexPath)) {
      console.log('🔄 Restoring backup...');
      fs.renameSync(backupPath, indexPath);
    }
    
    process.exit(1);
  }
}