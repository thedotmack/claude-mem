#!/usr/bin/env node

import fs from 'fs';
import { Database } from 'bun:sqlite';
import readline from 'readline';
import path from 'path';
import { homedir } from 'os';
import { globSync } from 'glob';

// =============================================================================
// TOOL REPLACEMENT DECISION TABLE
// =============================================================================
//
// KEY INSIGHT: Observations are the SEMANTIC SYNTHESIS of tool results.
// They contain what Claude LEARNED, which is what future Claude needs.
//
// Tool              | Replace OUTPUT? | Reason
// ------------------|-----------------|----------------------------------------
// Read              | ✅ YES          | Observation = what was learned from file
// Bash              | ✅ YES          | Observation = what command revealed
// Grep              | ✅ YES          | Observation = what search found
// Task              | ✅ YES          | Observation = what agent discovered
// WebFetch          | ✅ YES          | Observation = what page contained
// Glob              | ⚠️  MAYBE       | File lists are often small already
// WebSearch         | ⚠️  MAYBE       | Results are moderate size
// Edit              | ❌ NO           | OUTPUT is tiny ("success"), INPUT is ground truth
// Write             | ❌ NO           | OUTPUT is tiny, INPUT is the file content
// NotebookEdit      | ❌ NO           | OUTPUT is tiny, INPUT is the code
// TodoWrite         | ❌ NO           | Both tiny
// AskUserQuestion   | ❌ NO           | Both small, user input matters
// mcp__*            | ⚠️  MAYBE       | Varies by tool
//
// NEVER REPLACE INPUT - it contains the action (diff, command, query, path)
// ONLY REPLACE OUTPUT - swap raw results for semantic synthesis (observation)
//
// REPLACEMENT FORMAT:
// Original output gets replaced with:
//   "[Strategically Omitted by Claude-Mem to save tokens]
//
//    [Observation: Title here]
//    Facts: ...
//    Concepts: ..."
// =============================================================================

// Configuration
const DB_PATH = path.join(homedir(), '.claude-mem', 'claude-mem.db');
const MAX_TRANSCRIPTS = parseInt(process.env.MAX_TRANSCRIPTS || '500', 10);

// Find transcript files (most recent first)
const TRANSCRIPT_DIR = path.join(homedir(), '.claude/projects/-Users-alexnewman-Scripts-claude-mem');
const allTranscriptFiles = globSync(path.join(TRANSCRIPT_DIR, '*.jsonl'));

// Sort by modification time (most recent first), take MAX_TRANSCRIPTS
const transcriptFiles = allTranscriptFiles
  .map(f => ({ path: f, mtime: fs.statSync(f).mtime }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, MAX_TRANSCRIPTS)
  .map(f => f.path);

console.log(`Config: MAX_TRANSCRIPTS=${MAX_TRANSCRIPTS}`);
console.log(`Using ${transcriptFiles.length} most recent transcript files (of ${allTranscriptFiles.length} total)\n`);

// Map to store original content from transcript (both inputs and outputs)
const originalContent = new Map();

// Track contaminated (already transformed) transcripts
let skippedTranscripts = 0;

// Marker for already-transformed content (endless mode replacement format)
const TRANSFORMATION_MARKER = '**Key Facts:**';

// Auto-discover agent transcripts linked to main session
async function discoverAgentFiles(mainTranscriptPath) {
  console.log('Discovering linked agent transcripts...');

  const agentIds = new Set();
  const fileStream = fs.createReadStream(mainTranscriptPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.includes('agentId')) continue;

    try {
      const obj = JSON.parse(line);

      // Check for agentId in toolUseResult
      if (obj.toolUseResult?.agentId) {
        agentIds.add(obj.toolUseResult.agentId);
      }
    } catch (e) {
      // Skip malformed lines
    }
  }

  // Build agent file paths
  const directory = path.dirname(mainTranscriptPath);
  const agentFiles = Array.from(agentIds).map(id =>
    path.join(directory, `agent-${id}.jsonl`)
  ).filter(filePath => fs.existsSync(filePath));

  console.log(`  → Found ${agentIds.size} agent IDs`);
  console.log(`  → ${agentFiles.length} agent files exist on disk\n`);

  return agentFiles;
}

// Parse transcript to get BOTH tool_use (inputs) and tool_result (outputs) content
// Returns true if transcript is clean, false if contaminated (already transformed)
async function loadOriginalContentFromFile(filePath, fileLabel) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let count = 0;
  let isContaminated = false;
  const toolUseIdsFromThisFile = new Set();

  for await (const line of rl) {
    if (!line.includes('toolu_')) continue;

    try {
      const obj = JSON.parse(line);

      if (obj.message?.content) {
        for (const item of obj.message.content) {
          // Capture tool_use (inputs)
          if (item.type === 'tool_use' && item.id) {
            const existing = originalContent.get(item.id) || { input: '', output: '', name: '' };
            existing.input = JSON.stringify(item.input || {});
            existing.name = item.name;
            originalContent.set(item.id, existing);
            toolUseIdsFromThisFile.add(item.id);
            count++;
          }

          // Capture tool_result (outputs)
          if (item.type === 'tool_result' && item.tool_use_id) {
            const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);

            // Check for transformation marker - if found, transcript is contaminated
            if (content.includes(TRANSFORMATION_MARKER)) {
              isContaminated = true;
            }

            const existing = originalContent.get(item.tool_use_id) || { input: '', output: '', name: '' };
            existing.output = content;
            originalContent.set(item.tool_use_id, existing);
            toolUseIdsFromThisFile.add(item.tool_use_id);
          }
        }
      }
    } catch (e) {
      // Skip malformed lines
    }
  }

  // If contaminated, remove all data from this file and report
  if (isContaminated) {
    for (const id of toolUseIdsFromThisFile) {
      originalContent.delete(id);
    }
    console.log(`  ⚠️  Skipped ${fileLabel} (already transformed)`);
    return false;
  }

  if (count > 0) {
    console.log(`  → Found ${count} tool uses in ${fileLabel}`);
  }
  return true;
}

async function loadOriginalContent() {
  console.log('Loading original content from transcripts...');
  console.log(`  → Scanning ${transcriptFiles.length} transcript files...\n`);

  let cleanTranscripts = 0;

  // Load from all transcript files
  for (const transcriptFile of transcriptFiles) {
    const filename = path.basename(transcriptFile);
    const isClean = await loadOriginalContentFromFile(transcriptFile, filename);
    if (isClean) {
      cleanTranscripts++;
    } else {
      skippedTranscripts++;
    }
  }

  // Also check for any agent files not already included
  for (const transcriptFile of transcriptFiles) {
    if (transcriptFile.includes('agent-')) continue; // Already an agent file
    const agentFiles = await discoverAgentFiles(transcriptFile);
    for (const agentFile of agentFiles) {
      if (transcriptFiles.includes(agentFile)) continue; // Already processed
      const filename = path.basename(agentFile);
      const isClean = await loadOriginalContentFromFile(agentFile, `agent transcript (${filename})`);
      if (!isClean) {
        skippedTranscripts++;
      }
    }
  }

  console.log(`\nTotal: Loaded original content for ${originalContent.size} tool uses (inputs + outputs)`);
  if (skippedTranscripts > 0) {
    console.log(`⚠️  Skipped ${skippedTranscripts} transcripts (already transformed with endless mode)`);
  }
  console.log();
}

// Strip __N suffix from tool_use_id to get base ID
function getBaseToolUseId(id) {
  return id ? id.replace(/__\d+$/, '') : id;
}

// Query observations from database using tool_use_ids found in transcripts
// Handles suffixed IDs like toolu_abc__1, toolu_abc__2 matching transcript's toolu_abc
function queryObservations() {
  // Get tool_use_ids from the loaded transcript content
  const toolUseIds = Array.from(originalContent.keys());

  if (toolUseIds.length === 0) {
    console.log('No tool use IDs found in transcripts\n');
    return [];
  }

  console.log(`Querying observations for ${toolUseIds.length} tool use IDs from transcripts...`);

  const db = new Database(DB_PATH, { readonly: true });

  // Build LIKE clauses to match both exact IDs and suffixed variants (toolu_abc, toolu_abc__1, etc)
  const likeConditions = toolUseIds.map(() => 'tool_use_id LIKE ?').join(' OR ');
  const likeParams = toolUseIds.map(id => `${id}%`);

  const query = `
    SELECT
      id,
      tool_use_id,
      type,
      narrative,
      title,
      facts,
      concepts,
      LENGTH(COALESCE(facts,'')) as facts_len,
      LENGTH(COALESCE(title,'')) + LENGTH(COALESCE(facts,'')) as title_facts_len,
      LENGTH(COALESCE(title,'')) + LENGTH(COALESCE(facts,'')) + LENGTH(COALESCE(concepts,'')) as compact_len,
      LENGTH(COALESCE(narrative,'')) as narrative_len,
      LENGTH(COALESCE(title,'')) + LENGTH(COALESCE(narrative,'')) + LENGTH(COALESCE(facts,'')) + LENGTH(COALESCE(concepts,'')) as full_obs_len
    FROM observations
    WHERE ${likeConditions}
    ORDER BY created_at DESC
  `;

  const observations = db.prepare(query).all(...likeParams);
  db.close();

  console.log(`Found ${observations.length} observations matching tool use IDs (including suffixed variants)\n`);

  return observations;
}

// Tools eligible for OUTPUT replacement (observation = semantic synthesis of result)
const REPLACEABLE_TOOLS = new Set(['Read', 'Bash', 'Grep', 'Task', 'WebFetch', 'Glob', 'WebSearch']);

// Analyze OUTPUT-only replacement for eligible tools
function analyzeTransformations(observations) {
  console.log('='.repeat(110));
  console.log('OUTPUT REPLACEMENT ANALYSIS (Eligible Tools Only)');
  console.log('='.repeat(110));
  console.log();
  console.log('Eligible tools:', Array.from(REPLACEABLE_TOOLS).join(', '));
  console.log();

  // Group observations by BASE tool_use_id (strip __N suffix)
  // This groups toolu_abc, toolu_abc__1, toolu_abc__2 together
  const obsByToolId = new Map();
  observations.forEach(obs => {
    const baseId = getBaseToolUseId(obs.tool_use_id);
    if (!obsByToolId.has(baseId)) {
      obsByToolId.set(baseId, []);
    }
    obsByToolId.get(baseId).push(obs);
  });

  // Define strategies to test
  const strategies = [
    { name: 'facts_only', field: 'facts_len', desc: 'Facts only (~400 chars)' },
    { name: 'title_facts', field: 'title_facts_len', desc: 'Title + Facts (~450 chars)' },
    { name: 'compact', field: 'compact_len', desc: 'Title + Facts + Concepts (~500 chars)' },
    { name: 'narrative', field: 'narrative_len', desc: 'Narrative only (~700 chars)' },
    { name: 'full', field: 'full_obs_len', desc: 'Full observation (~1200 chars)' }
  ];

  // Track results per strategy
  const results = {};
  strategies.forEach(s => {
    results[s.name] = {
      transforms: 0,
      noTransform: 0,
      saved: 0,
      totalOriginal: 0
    };
  });

  // Track stats
  let eligible = 0;
  let ineligible = 0;
  let noTranscript = 0;
  const toolCounts = {};

  // Analyze each tool use
  obsByToolId.forEach((obsArray, toolUseId) => {
    const original = originalContent.get(toolUseId);
    const toolName = original?.name || 'unknown';
    const outputLen = original?.output?.length || 0;

    // Skip if no transcript data
    if (!original || outputLen === 0) {
      noTranscript++;
      return;
    }

    // Skip if tool not eligible for replacement
    if (!REPLACEABLE_TOOLS.has(toolName)) {
      ineligible++;
      return;
    }

    eligible++;
    toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;

    // Sum lengths across ALL observations for this tool use (handles multiple obs per tool_use_id)
    // Test each strategy - OUTPUT replacement only
    strategies.forEach(strategy => {
      const obsLen = obsArray.reduce((sum, obs) => sum + (obs[strategy.field] || 0), 0);
      const r = results[strategy.name];

      r.totalOriginal += outputLen;

      if (obsLen > 0 && obsLen < outputLen) {
        r.transforms++;
        r.saved += (outputLen - obsLen);
      } else {
        r.noTransform++;
      }
    });
  });

  // Print results
  console.log('TOOL BREAKDOWN:');
  Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).forEach(([tool, count]) => {
    console.log(`  ${tool}: ${count}`);
  });
  console.log();
  console.log('-'.repeat(100));
  console.log(`Eligible tool uses: ${eligible}`);
  console.log(`Ineligible (Edit/Write/etc): ${ineligible}`);
  console.log(`No transcript data: ${noTranscript}`);
  console.log('-'.repeat(100));
  console.log();
  console.log('Strategy                          Transforms   No Transform   Chars Saved      Original Size    Savings %');
  console.log('-'.repeat(100));

  strategies.forEach(strategy => {
    const r = results[strategy.name];
    const pct = r.totalOriginal > 0 ? ((r.saved / r.totalOriginal) * 100).toFixed(1) : '0.0';
    console.log(
      `${strategy.desc.padEnd(35)} ${String(r.transforms).padStart(10)}   ${String(r.noTransform).padStart(12)}   ${String(r.saved.toLocaleString()).padStart(13)}   ${String(r.totalOriginal.toLocaleString()).padStart(15)}   ${pct.padStart(8)}%`
    );
  });

  console.log('-'.repeat(100));
  console.log();

  // Find best strategy
  let bestStrategy = null;
  let bestSavings = 0;
  strategies.forEach(strategy => {
    if (results[strategy.name].saved > bestSavings) {
      bestSavings = results[strategy.name].saved;
      bestStrategy = strategy;
    }
  });

  if (bestStrategy) {
    const r = results[bestStrategy.name];
    const pct = ((r.saved / r.totalOriginal) * 100).toFixed(1);
    console.log(`BEST STRATEGY: ${bestStrategy.desc}`);
    console.log(`  - Transforms ${r.transforms} of ${eligible} eligible tool uses (${((r.transforms/eligible)*100).toFixed(1)}%)`);
    console.log(`  - Saves ${r.saved.toLocaleString()} of ${r.totalOriginal.toLocaleString()} chars (${pct}% reduction)`);
  }

  console.log();
}

// Main execution
async function main() {
  await loadOriginalContent();
  const observations = queryObservations();
  analyzeTransformations(observations);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
