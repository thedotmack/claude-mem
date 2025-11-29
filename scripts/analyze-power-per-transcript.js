#!/usr/bin/env node
/**
 * Per-Transcript Power Consumption Analysis
 *
 * Uses the same filtering as analyze-transformations-smart.js but calculates
 * POWER CONSUMPTION per transcript using ACTUAL observation sizes from database.
 *
 * Power = Σ(tool_output_bytes × subsequent_api_calls)
 * Compressed Power = Σ(observation_bytes × subsequent_api_calls)
 * Control = 100% (no compression)
 */

import fs from 'fs';
import readline from 'readline';
import path from 'path';
import { homedir } from 'os';
import { globSync } from 'glob';
import Database from 'better-sqlite3';

// Configuration (same as analyze-transformations-smart.js)
const MAX_TRANSCRIPTS = parseInt(process.env.MAX_TRANSCRIPTS || '20', 10);
const TRANSCRIPT_DIR = path.join(homedir(), '.claude/projects/-Users-alexnewman-Scripts-claude-mem');
const DB_PATH = path.join(homedir(), '.claude-mem', 'claude-mem.db');
const TRANSFORMATION_MARKER = '**Key Facts:**';

// Load observation sizes from database (facts-only strategy)
function loadObservationSizes() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT tool_use_id, LENGTH(COALESCE(facts,'')) as facts_len
    FROM observations
    WHERE tool_use_id IS NOT NULL
  `).all();
  db.close();

  const sizes = new Map();
  for (const row of rows) {
    // Strip __N suffix for matching
    const baseId = row.tool_use_id.replace(/__\d+$/, '');
    const existing = sizes.get(baseId) || 0;
    sizes.set(baseId, existing + row.facts_len);
  }
  return sizes;
}

const observationSizes = loadObservationSizes();
console.log(`Loaded ${observationSizes.size} observation sizes from database\n`);

// Find transcripts that have matching observations in database
function findTranscriptsWithObservations() {
  const db = new Database(DB_PATH, { readonly: true });
  const dbIds = new Set(
    db.prepare('SELECT DISTINCT tool_use_id FROM observations WHERE tool_use_id IS NOT NULL')
      .all()
      .map(r => r.tool_use_id.replace(/__\d+$/, ''))
  );
  db.close();

  const allFiles = globSync(path.join(TRANSCRIPT_DIR, '*.jsonl'))
    .filter(f => !f.includes('agent-'));

  const filesWithMatches = [];
  for (const f of allFiles) {
    const content = fs.readFileSync(f, 'utf-8');
    const ids = [...content.matchAll(/"tool_use_id":"([^"]+)"/g)].map(m => m[1]);
    const uniqueIds = [...new Set(ids)];

    let matches = 0;
    for (const id of uniqueIds) {
      if (dbIds.has(id)) matches++;
    }

    if (matches >= 5 && uniqueIds.length >= 10) {
      filesWithMatches.push({
        path: f,
        matches,
        total: uniqueIds.length,
        matchRate: matches / uniqueIds.length
      });
    }
  }

  // Sort by match count descending
  return filesWithMatches
    .sort((a, b) => b.matches - a.matches)
    .slice(0, MAX_TRANSCRIPTS * 2)
    .map(f => f.path);
}

const transcriptFiles = findTranscriptsWithObservations();
console.log(`Found ${transcriptFiles.length} transcripts with observation matches\n`);

// Analyze a single transcript for power consumption
async function analyzeTranscriptPower(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  // Track chronological events
  const events = [];
  let messageOrder = 0;
  let isContaminated = false;

  for await (const line of rl) {
    try {
      const obj = JSON.parse(line);

      // Track assistant messages (API calls)
      if (obj.type === 'assistant') {
        events.push({ type: 'api_call', order: messageOrder });
      }

      // Track tool results from user messages
      if (obj.type === 'user' && obj.message?.content && Array.isArray(obj.message.content)) {
        for (const item of obj.message.content) {
          if (item.type === 'tool_result' && item.tool_use_id && item.content) {
            const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);

            // Check contamination
            if (content.includes(TRANSFORMATION_MARKER)) {
              isContaminated = true;
            }

            // Skip tiny outputs and errors
            if (content.length < 100 || content.includes('<tool_use_error>')) {
              continue;
            }

            events.push({
              type: 'tool_result',
              order: messageOrder,
              toolUseId: item.tool_use_id,
              bytes: Buffer.byteLength(content, 'utf-8')
            });
          }
        }
      }

      messageOrder++;
    } catch (e) {
      // Skip malformed lines
    }
  }

  if (isContaminated) {
    return { contaminated: true };
  }

  const toolResults = events.filter(e => e.type === 'tool_result');
  const apiCalls = events.filter(e => e.type === 'api_call');

  if (toolResults.length < 3) {
    return null; // Not enough data
  }

  // Calculate power for each tool result (control and compressed)
  let controlPower = 0;
  let compressedPower = 0;
  let totalToolBytes = 0;
  let matchedCount = 0;

  for (const tr of toolResults) {
    const subsequentCalls = apiCalls.filter(ac => ac.order > tr.order).length;
    const controlContribution = tr.bytes * subsequentCalls;
    controlPower += controlContribution;
    totalToolBytes += tr.bytes;

    // Look up actual observation size
    const obsSize = observationSizes.get(tr.toolUseId);
    if (obsSize !== undefined && obsSize < tr.bytes) {
      compressedPower += obsSize * subsequentCalls;
      matchedCount++;
    } else {
      // No observation or observation larger than original - use original
      compressedPower += controlContribution;
    }
  }

  const avgSubsequent = toolResults.reduce((s, t) => s + apiCalls.filter(ac => ac.order > t.order).length, 0) / toolResults.length;
  const powerPct = controlPower > 0 ? ((compressedPower / controlPower) * 100).toFixed(1) : '100.0';
  const savedPct = controlPower > 0 ? (((controlPower - compressedPower) / controlPower) * 100).toFixed(1) : '0.0';

  return {
    filename: path.basename(filePath),
    toolResults: toolResults.length,
    apiCalls: apiCalls.length,
    matched: matchedCount,
    totalToolBytes,
    controlPower,
    compressedPower,
    powerPct,
    savedPct,
    avgSubsequent: avgSubsequent.toFixed(1)
  };
}

// Main
async function main() {
  console.log('='.repeat(120));
  console.log('PER-TRANSCRIPT POWER CONSUMPTION ANALYSIS (Using Actual Observation Sizes)');
  console.log('='.repeat(120));
  console.log();
  console.log('Power = Σ(bytes × subsequent_api_calls)');
  console.log('Control = original tool outputs, Compressed = actual observation sizes from database');
  console.log();

  const results = [];
  let skipped = 0;

  for (const f of transcriptFiles) {
    const result = await analyzeTranscriptPower(f);
    if (result?.contaminated) {
      skipped++;
      continue;
    }
    if (result && parseFloat(result.avgSubsequent) > 2) {
      results.push(result);
      if (results.length >= MAX_TRANSCRIPTS) break;
    }
  }

  if (skipped > 0) {
    console.log(`Skipped ${skipped} contaminated transcripts\n`);
  }

  // Sort by control power
  results.sort((a, b) => b.controlPower - a.controlPower);

  // Print per-transcript table with actual power savings
  console.log('Transcript'.padEnd(40) + 'Tools'.padStart(6) + 'Match'.padStart(6) + 'Ctrl MB'.padStart(10) + 'Comp MB'.padStart(10) + 'Power%'.padStart(8) + 'Saved%'.padStart(8));
  console.log('-'.repeat(88));

  for (const r of results) {
    console.log(
      r.filename.slice(0, 38).padEnd(40) +
      String(r.toolResults).padStart(6) +
      String(r.matched).padStart(6) +
      (r.controlPower / 1024 / 1024).toFixed(2).padStart(10) +
      (r.compressedPower / 1024 / 1024).toFixed(2).padStart(10) +
      (r.powerPct + '%').padStart(8) +
      (r.savedPct + '%').padStart(8)
    );
  }

  console.log('-'.repeat(88));
  console.log();

  // Summary
  const totalControl = results.reduce((s, r) => s + r.controlPower, 0);
  const totalCompressed = results.reduce((s, r) => s + r.compressedPower, 0);
  const totalTools = results.reduce((s, r) => s + r.toolResults, 0);
  const totalMatched = results.reduce((s, r) => s + r.matched, 0);

  const overallPowerPct = ((totalCompressed / totalControl) * 100).toFixed(1);
  const overallSavedPct = (((totalControl - totalCompressed) / totalControl) * 100).toFixed(1);

  console.log('SUMMARY');
  console.log('-'.repeat(60));
  console.log(`Transcripts analyzed: ${results.length}`);
  console.log(`Total tool results: ${totalTools}`);
  console.log(`Tool results with observations: ${totalMatched} (${((totalMatched/totalTools)*100).toFixed(0)}%)`);
  console.log();
  console.log(`Control power (no compression):   ${(totalControl / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Compressed power (observations):  ${(totalCompressed / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Power consumption: ${overallPowerPct}% of control`);
  console.log(`Power saved: ${overallSavedPct}%`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
