#!/usr/bin/env node

import fs from 'fs';
import Database from 'better-sqlite3';
import readline from 'readline';

// Configuration
const ANALYSIS_JSON = '/tmp/tool-use-analysis.json';
const JSONL_PATH = '/Users/alexnewman/.claude/projects/-Users-alexnewman-Scripts-claude-mem/4094399f-bbd7-425b-855a-b985fe9c0dee.jsonl';
const DB_PATH = '/Users/alexnewman/.claude-mem/claude-mem.db';

// Load analysis data to get tool use IDs
console.log('Loading tool use IDs from analysis...');
const analysis = JSON.parse(fs.readFileSync(ANALYSIS_JSON, 'utf-8'));
const toolUseIds = analysis.summary.allToolUseIds;
console.log(`Found ${toolUseIds.length} unique tool use IDs\n`);

// Map to store original content from transcript (both inputs and outputs)
const originalContent = new Map();

// Parse transcript to get BOTH tool_use (inputs) and tool_result (outputs) content
async function loadOriginalContent() {
  console.log('Loading original content from transcript...');

  const fileStream = fs.createReadStream(JSONL_PATH);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.includes('toolu_')) continue;

    try {
      const obj = JSON.parse(line);

      if (obj.message?.content) {
        for (const item of obj.message.content) {
          // Capture tool_use (inputs)
          if (item.type === 'tool_use' && item.id) {
            const existing = originalContent.get(item.id) || { input: '', output: '' };
            existing.input = JSON.stringify(item.input || {});
            existing.name = item.name;
            originalContent.set(item.id, existing);
          }

          // Capture tool_result (outputs)
          if (item.type === 'tool_result' && item.tool_use_id) {
            const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
            const existing = originalContent.get(item.tool_use_id) || { input: '', output: '' };
            existing.output = content;
            originalContent.set(item.tool_use_id, existing);
          }
        }
      }
    } catch (e) {
      // Skip malformed lines
    }
  }

  console.log(`Loaded original content for ${originalContent.size} tool uses (inputs + outputs)\n`);
}

// Query observations from database
function queryObservations() {
  console.log('Querying observations from database...');

  const db = new Database(DB_PATH, { readonly: true });

  // Build IN clause with placeholders
  const placeholders = toolUseIds.map(() => '?').join(',');
  const query = `
    SELECT
      id,
      tool_use_id,
      type,
      text,
      title,
      subtitle,
      narrative,
      facts,
      concepts,
      files_read,
      files_modified,
      sdk_session_id,
      created_at
    FROM observations
    WHERE tool_use_id IN (${placeholders})
    ORDER BY created_at DESC
  `;

  const observations = db.prepare(query).all(...toolUseIds);
  db.close();

  console.log(`Found ${observations.length} observations matching tool use IDs\n`);

  return observations;
}

// Generate statistics and print results
function printResults(observations) {
  console.log('='.repeat(100));
  console.log('OBSERVATION MATCHING ANALYSIS');
  console.log('='.repeat(100));
  console.log();

  // Statistics
  const matchedToolUseIds = new Set(observations.map(obs => obs.tool_use_id));
  const matchRate = ((matchedToolUseIds.size / toolUseIds.length) * 100).toFixed(1);

  console.log('STATISTICS');
  console.log('-'.repeat(100));
  console.log(`Total tool use IDs:              ${toolUseIds.length}`);
  console.log(`Tool IDs with observations:      ${matchedToolUseIds.size} (${matchRate}%)`);
  console.log(`Tool IDs without observations:   ${toolUseIds.length - matchedToolUseIds.size}`);
  console.log(`Total observations found:        ${observations.length}`);
  console.log();

  // Character count comparisons - ONLY comparing INPUT vs OBSERVATION
  console.log('TRANSFORMATION CANDIDATES (Input vs Observation - Only Positive Reductions)');
  console.log('-'.repeat(110));
  console.log('Tool Use ID                          Tool Name              Input    Observation   Reduction   Candidate');
  console.log('-'.repeat(110));

  let totalInput = 0;
  let totalObservation = 0;
  let candidateCount = 0;
  let nonCandidateCount = 0;
  const candidates = [];

  observations.forEach(obs => {
    const original = originalContent.get(obs.tool_use_id);
    const inputLen = original?.input?.length || 0;
    const toolName = original?.name || 'unknown';

    // Only narrative (exclude everything else)
    const obsContent = [
      // obs.text,       // EXCLUDED
      // obs.title,      // EXCLUDED
      // obs.subtitle,   // EXCLUDED
      obs.narrative,     // KEPT - the story only
      // obs.facts,      // EXCLUDED
      // obs.concepts,   // EXCLUDED
      // obs.files_read,    // EXCLUDED
      // obs.files_modified // EXCLUDED
    ].filter(Boolean).join('');

    const obsLen = obsContent.length;

    if (inputLen > 0 && obsLen > 0) {
      const reduction = ((1 - (obsLen / inputLen)) * 100).toFixed(1);
      const isCandidate = obsLen < inputLen; // Observation is smaller than input
      const status = isCandidate ? '✓ YES' : '✗ NO';

      console.log(
        `${obs.tool_use_id.padEnd(36)} ${toolName.padEnd(22)} ${String(inputLen).padStart(8)} ${String(obsLen).padStart(13)}   ${String(reduction).padStart(8)}%   ${status}`
      );

      if (isCandidate) {
        totalInput += inputLen;
        totalObservation += obsLen;
        candidateCount++;
        candidates.push({
          tool_use_id: obs.tool_use_id,
          tool_name: toolName,
          input_len: inputLen,
          obs_len: obsLen,
          reduction: parseFloat(reduction)
        });
      } else {
        nonCandidateCount++;
      }
    } else if (inputLen === 0) {
      console.log(
        `${obs.tool_use_id.padEnd(36)} ${toolName.padEnd(22)} ${String(inputLen).padStart(8)} ${String(obsLen).padStart(13)}   ${'N/A'.padStart(8)}    ✗ NO (no input)`
      );
      nonCandidateCount++;
    } else {
      console.log(
        `${obs.tool_use_id.padEnd(36)} ${toolName.padEnd(22)} ${String(inputLen).padStart(8)} ${String(obsLen).padStart(13)}   ${'N/A'.padStart(8)}    ✗ NO`
      );
      nonCandidateCount++;
    }
  });

  console.log('-'.repeat(110));

  console.log();
  console.log('SUMMARY');
  console.log('-'.repeat(110));
  console.log(`Total observations analyzed:         ${observations.length}`);
  console.log(`Transformation candidates (✓ YES):   ${candidateCount}`);
  console.log(`Non-candidates (✗ NO):               ${nonCandidateCount}`);
  console.log();

  if (candidateCount > 0) {
    const avgReduction = ((1 - (totalObservation / totalInput)) * 100).toFixed(1);
    const charsSaved = totalInput - totalObservation;

    console.log('TRANSFORMATION IMPACT (Candidates Only)');
    console.log('-'.repeat(110));
    console.log(`Total input characters:              ${totalInput.toLocaleString()}`);
    console.log(`Total observation characters:        ${totalObservation.toLocaleString()}`);
    console.log(`Characters saved:                    ${charsSaved.toLocaleString()} (${avgReduction}% reduction)`);
    console.log();

    // Sort candidates by reduction percentage (highest first)
    const topCandidates = candidates.sort((a, b) => b.reduction - a.reduction).slice(0, 10);
    console.log('TOP 10 TRANSFORMATION CANDIDATES (by reduction %):');
    console.log('-'.repeat(110));
    topCandidates.forEach((c, i) => {
      console.log(`${String(i + 1).padStart(2)}. ${c.tool_use_id} (${c.tool_name}): ${c.input_len} → ${c.obs_len} chars (${c.reduction.toFixed(1)}% reduction)`);
    });
  } else {
    console.log('No transformation candidates found (all observations are larger than or equal to inputs)');
  }

  console.log();
  console.log('='.repeat(110));
}

// Main execution
async function main() {
  await loadOriginalContent();
  const observations = queryObservations();
  printResults(observations);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
