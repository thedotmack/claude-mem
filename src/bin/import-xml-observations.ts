#!/usr/bin/env node
/**
 * Import XML observations back into the database
 * Parses actual_xml_only_with_timestamps.xml and inserts observations via SessionStore
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { logger } from '../utils/logger.js';

interface ObservationData {
  type: string;
  title: string;
  subtitle: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

interface SummaryData {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}

interface SessionMetadata {
  sessionId: string;
  project: string;
}

interface TimestampMapping {
  [timestamp: string]: SessionMetadata;
}

/**
 * Build a map of timestamp (rounded to second) -> session metadata by reading all transcript files
 * Since XML timestamps are rounded to seconds, we map by second
 */
function buildTimestampMap(): TimestampMapping {
  const transcriptDir = join(homedir(), '.claude', 'projects', '-Users-alexnewman-Scripts-claude-mem');
  const map: TimestampMapping = {};

  console.log(`Reading transcript files from ${transcriptDir}...`);

  const files = readdirSync(transcriptDir).filter(f => f.endsWith('.jsonl'));
  console.log(`Found ${files.length} transcript files`);

  for (const filename of files) {
    const filepath = join(transcriptDir, filename);
    const content = readFileSync(filepath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      try {
        const data = JSON.parse(line);
        const timestamp = data.timestamp;
        const sessionId = data.sessionId;
        const project = data.cwd;

        if (timestamp && sessionId) {
          // Round timestamp to second for matching with XML timestamps
          const roundedTimestamp = new Date(timestamp);
          roundedTimestamp.setMilliseconds(0);
          const key = roundedTimestamp.toISOString();

          // Only store first occurrence for each second (they're all the same session anyway)
          if (!map[key]) {
            map[key] = { sessionId, project };
          }
        }
      } catch (e) {
        logger.debug('IMPORT', 'Skipping invalid JSON line', {
          lineNumber: index + 1,
          filename,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }
  }

  console.log(`Built timestamp map with ${Object.keys(map).length} unique seconds`);
  return map;
}

/**
 * Parse XML text content and extract tag value
 */
function extractTag(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

/**
 * Parse XML array tags (facts, concepts, files, etc.)
 */
function extractArrayTags(xml: string, containerTag: string, itemTag: string): string[] {
  const containerRegex = new RegExp(`<${containerTag}>([\\s\\S]*?)</${containerTag}>`, 'i');
  const containerMatch = xml.match(containerRegex);

  if (!containerMatch) {
    return [];
  }

  const containerContent = containerMatch[1];
  const itemRegex = new RegExp(`<${itemTag}>([\\s\\S]*?)</${itemTag}>`, 'gi');
  const items: string[] = [];
  let match;

  while ((match = itemRegex.exec(containerContent)) !== null) {
    items.push(match[1].trim());
  }

  return items;
}

/**
 * Parse an observation block from XML
 */
function parseObservation(xml: string): ObservationData | null {
  // Must be a complete observation block
  if (!xml.includes('<observation>') || !xml.includes('</observation>')) {
    return null;
  }

  try {
    const observation: ObservationData = {
      type: extractTag(xml, 'type'),
      title: extractTag(xml, 'title'),
      subtitle: extractTag(xml, 'subtitle'),
      facts: extractArrayTags(xml, 'facts', 'fact'),
      narrative: extractTag(xml, 'narrative'),
      concepts: extractArrayTags(xml, 'concepts', 'concept'),
      files_read: extractArrayTags(xml, 'files_read', 'file'),
      files_modified: extractArrayTags(xml, 'files_modified', 'file'),
    };

    // Validate required fields
    if (!observation.type || !observation.title) {
      return null;
    }

    return observation;
  } catch (e) {
    console.error('Error parsing observation:', e);
    return null;
  }
}

/**
 * Parse a summary block from XML
 */
function parseSummary(xml: string): SummaryData | null {
  // Must be a complete summary block
  if (!xml.includes('<summary>') || !xml.includes('</summary>')) {
    return null;
  }

  try {
    const summary: SummaryData = {
      request: extractTag(xml, 'request'),
      investigated: extractTag(xml, 'investigated'),
      learned: extractTag(xml, 'learned'),
      completed: extractTag(xml, 'completed'),
      next_steps: extractTag(xml, 'next_steps'),
      notes: extractTag(xml, 'notes') || null,
    };

    // Validate required fields
    if (!summary.request) {
      return null;
    }

    return summary;
  } catch (e) {
    console.error('Error parsing summary:', e);
    return null;
  }
}

/**
 * Extract timestamp from XML comment
 * Format: <!-- Block N | 2025-10-19 03:03:23 UTC -->
 */
function extractTimestamp(commentLine: string): string | null {
  const match = commentLine.match(/<!-- Block \d+ \| (.+?) -->/);
  if (match) {
    // Convert "2025-10-19 03:03:23 UTC" to ISO format
    const dateStr = match[1].replace(' UTC', '').replace(' ', 'T') + 'Z';
    return new Date(dateStr).toISOString();
  }
  return null;
}

/**
 * Main import function
 */
function main() {
  console.log('Starting XML observation import...\n');

  // Build timestamp map
  const timestampMap = buildTimestampMap();

  // Open database connection
  const db = new SessionStore();

  // Create SDK sessions for all unique Claude Code sessions
  console.log('\nCreating SDK sessions for imported data...');
  const claudeSessionToSdkSession = new Map<string, string>();

  for (const sessionMeta of Object.values(timestampMap)) {
    if (!claudeSessionToSdkSession.has(sessionMeta.sessionId)) {
      const syntheticSdkSessionId = `imported-${sessionMeta.sessionId}`;

      // Try to find existing session first
      const existingQuery = db['db'].prepare(`
        SELECT memory_session_id
        FROM sdk_sessions
        WHERE content_session_id = ?
      `);
      const existing = existingQuery.get(sessionMeta.sessionId) as { memory_session_id: string | null } | undefined;

      if (existing && existing.memory_session_id) {
        // Use existing SDK session ID
        claudeSessionToSdkSession.set(sessionMeta.sessionId, existing.memory_session_id);
      } else if (existing && !existing.memory_session_id) {
        // Session exists but memory_session_id is NULL, update it
        db['db'].prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE content_session_id = ?')
          .run(syntheticSdkSessionId, sessionMeta.sessionId);
        claudeSessionToSdkSession.set(sessionMeta.sessionId, syntheticSdkSessionId);
      } else {
        // Create new SDK session
        db.createSDKSession(
          sessionMeta.sessionId,
          sessionMeta.project,
          'Imported from transcript XML'
        );

        // Update with synthetic SDK session ID
        db['db'].prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE content_session_id = ?')
          .run(syntheticSdkSessionId, sessionMeta.sessionId);

        claudeSessionToSdkSession.set(sessionMeta.sessionId, syntheticSdkSessionId);
      }
    }
  }

  console.log(`Prepared ${claudeSessionToSdkSession.size} SDK sessions\n`);

  // Read XML file
  const xmlPath = join(process.cwd(), 'actual_xml_only_with_timestamps.xml');
  console.log(`Reading XML file: ${xmlPath}`);
  const xmlContent = readFileSync(xmlPath, 'utf-8');

  // Split into blocks by comment markers
  const blocks = xmlContent.split(/(?=<!-- Block \d+)/);
  console.log(`Found ${blocks.length} blocks in XML file\n`);

  let importedObs = 0;
  let importedSum = 0;
  let skipped = 0;
  let duplicateObs = 0;
  let duplicateSum = 0;
  let noSession = 0;

  for (const block of blocks) {
    if (!block.trim() || block.startsWith('<?xml') || block.startsWith('<transcript_extracts')) {
      continue;
    }

    // Extract timestamp from comment
    const timestampIso = extractTimestamp(block);
    if (!timestampIso) {
      skipped++;
      continue;
    }

    // Look up session metadata
    const sessionMeta = timestampMap[timestampIso];
    if (!sessionMeta) {
      noSession++;
      if (noSession <= 5) {
        console.log(`⚠️  No session found for timestamp: ${timestampIso}`);
      }
      skipped++;
      continue;
    }

    // Get SDK session ID
    const memorySessionId = claudeSessionToSdkSession.get(sessionMeta.sessionId);
    if (!memorySessionId) {
      skipped++;
      continue;
    }

    // Try parsing as observation first
    const observation = parseObservation(block);
    if (observation) {
      // Check for duplicate
      const existingObs = db['db'].prepare(`
        SELECT id FROM observations
        WHERE memory_session_id = ? AND title = ? AND subtitle = ? AND type = ?
      `).get(memorySessionId, observation.title, observation.subtitle, observation.type);

      if (existingObs) {
        duplicateObs++;
        continue;
      }

      try {
        db.storeObservation(
          memorySessionId,
          sessionMeta.project,
          observation
        );
        importedObs++;

        if (importedObs % 50 === 0) {
          console.log(`Imported ${importedObs} observations...`);
        }
      } catch (e) {
        console.error(`Error storing observation:`, e);
        skipped++;
      }
      continue;
    }

    // Try parsing as summary
    const summary = parseSummary(block);
    if (summary) {
      // Check for duplicate
      const existingSum = db['db'].prepare(`
        SELECT id FROM session_summaries
        WHERE memory_session_id = ? AND request = ? AND completed = ? AND learned = ?
      `).get(memorySessionId, summary.request, summary.completed, summary.learned);

      if (existingSum) {
        duplicateSum++;
        continue;
      }

      try {
        db.storeSummary(
          memorySessionId,
          sessionMeta.project,
          summary
        );
        importedSum++;

        if (importedSum % 10 === 0) {
          console.log(`Imported ${importedSum} summaries...`);
        }
      } catch (e) {
        console.error(`Error storing summary:`, e);
        skipped++;
      }
      continue;
    }

    // Neither observation nor summary - skip
    skipped++;
  }

  db.close();

  console.log('\n' + '='.repeat(60));
  console.log('Import Complete!');
  console.log('='.repeat(60));
  console.log(`✓ Imported: ${importedObs} observations`);
  console.log(`✓ Imported: ${importedSum} summaries`);
  console.log(`✓ Total: ${importedObs + importedSum} items`);
  console.log(`⊘ Skipped: ${skipped} blocks (not full observations or summaries)`);
  console.log(`⊘ Duplicates skipped: ${duplicateObs} observations, ${duplicateSum} summaries`);
  console.log(`⚠️  No session: ${noSession} blocks (timestamp not in transcripts)`);
  console.log('='.repeat(60));
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
