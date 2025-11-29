#!/usr/bin/env node
/**
 * High-Coverage Transcript Analysis with Rolling Power Calculation
 *
 * Filters to transcripts with 60%+ observation coverage and shows
 * turn-by-turn power accumulation.
 */

import fs from 'fs';
import readline from 'readline';
import path from 'path';
import { homedir } from 'os';
import { globSync } from 'glob';
import Database from 'better-sqlite3';

const MIN_MATCH_RATE = 0.6;  // 60% coverage required
const MIN_TOOLS = 10;
const TRANSCRIPT_DIR = path.join(homedir(), '.claude/projects/-Users-alexnewman-Scripts-claude-mem');
const DB_PATH = path.join(homedir(), '.claude-mem', 'claude-mem.db');
const TRANSFORMATION_MARKER = '**Key Facts:**';

// Load observation sizes from database
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
    const baseId = row.tool_use_id.replace(/__\d+$/, '');
    const existing = sizes.get(baseId) || 0;
    sizes.set(baseId, existing + row.facts_len);
  }
  return sizes;
}

const observationSizes = loadObservationSizes();
console.log(`Loaded ${observationSizes.size} observation sizes from database\n`);

// Find high-coverage transcripts
function findHighCoverageTranscripts() {
  const db = new Database(DB_PATH, { readonly: true });
  const dbIds = new Set(
    db.prepare('SELECT DISTINCT tool_use_id FROM observations WHERE tool_use_id IS NOT NULL')
      .all()
      .map(r => r.tool_use_id.replace(/__\d+$/, ''))
  );
  db.close();

  const allFiles = globSync(path.join(TRANSCRIPT_DIR, '*.jsonl'))
    .filter(f => !f.includes('agent-'));

  const candidates = [];
  for (const f of allFiles) {
    const content = fs.readFileSync(f, 'utf-8');

    // Check contamination
    if (content.includes(TRANSFORMATION_MARKER)) continue;

    const ids = [...content.matchAll(/"tool_use_id":"([^"]+)"/g)].map(m => m[1]);
    const uniqueIds = [...new Set(ids)];

    let matches = 0;
    for (const id of uniqueIds) {
      if (dbIds.has(id)) matches++;
    }

    const matchRate = uniqueIds.length > 0 ? matches / uniqueIds.length : 0;

    if (matchRate >= MIN_MATCH_RATE && uniqueIds.length >= MIN_TOOLS) {
      candidates.push({
        path: f,
        matches,
        total: uniqueIds.length,
        matchRate
      });
    }
  }

  return candidates.sort((a, b) => b.matchRate - a.matchRate);
}

// Analyze a transcript with rolling turn-by-turn details
async function analyzeTranscriptRolling(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const events = [];
  let messageOrder = 0;

  for await (const line of rl) {
    try {
      const obj = JSON.parse(line);

      if (obj.type === 'assistant') {
        events.push({ type: 'api_call', order: messageOrder });
      }

      if (obj.type === 'user' && obj.message?.content && Array.isArray(obj.message.content)) {
        for (const item of obj.message.content) {
          if (item.type === 'tool_result' && item.tool_use_id && item.content) {
            const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
            if (content.length < 100 || content.includes('<tool_use_error>')) continue;

            events.push({
              type: 'tool_result',
              order: messageOrder,
              toolUseId: item.tool_use_id,
              bytes: Buffer.byteLength(content, 'utf-8'),
              toolName: extractToolName(item)
            });
          }
        }
      }
      messageOrder++;
    } catch (e) {}
  }

  const toolResults = events.filter(e => e.type === 'tool_result');
  const apiCalls = events.filter(e => e.type === 'api_call');

  if (toolResults.length < 5) return null;

  // Build rolling analysis
  const rolling = [];
  let cumCtrlTokens = 0;
  let cumCompTokens = 0;
  let cumCtrlPower = 0;
  let cumCompPower = 0;
  let matchedCount = 0;

  for (const tr of toolResults) {
    const subsequentCalls = apiCalls.filter(ac => ac.order > tr.order).length;
    const obsSize = observationSizes.get(tr.toolUseId);
    const hasObs = obsSize !== undefined && obsSize < tr.bytes;

    const ctrlBytes = tr.bytes;
    const compBytes = hasObs ? obsSize : tr.bytes;

    cumCtrlTokens += ctrlBytes;
    cumCompTokens += compBytes;
    cumCtrlPower += ctrlBytes * subsequentCalls;
    cumCompPower += compBytes * subsequentCalls;

    if (hasObs) matchedCount++;

    rolling.push({
      order: tr.order,
      tool: tr.toolName || 'unknown',
      ctrlBytes,
      compBytes,
      hasObs,
      subsequentCalls,
      cumCtrlTokens,
      cumCompTokens,
      cumCtrlPower,
      cumCompPower
    });
  }

  return {
    filename: path.basename(filePath),
    toolResults: toolResults.length,
    apiCalls: apiCalls.length,
    matched: matchedCount,
    matchRate: matchedCount / toolResults.length,
    rolling,
    finalCtrlTokens: cumCtrlTokens,
    finalCompTokens: cumCompTokens,
    finalCtrlPower: cumCtrlPower,
    finalCompPower: cumCompPower,
    tokenReduction: ((cumCtrlTokens - cumCompTokens) / cumCtrlTokens * 100).toFixed(1),
    powerReduction: ((cumCtrlPower - cumCompPower) / cumCtrlPower * 100).toFixed(1)
  };
}

function extractToolName(item) {
  // Try to extract tool name from context
  return item.tool_name || 'Tool';
}

// Format bytes
function fmtBytes(b) {
  if (b > 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' MB';
  if (b > 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

function fmtNum(n) {
  return n.toLocaleString();
}

// Main
async function main() {
  console.log('='.repeat(100));
  console.log('HIGH-COVERAGE TRANSCRIPT ANALYSIS (60%+ Observation Match Rate)');
  console.log('='.repeat(100));
  console.log();

  const candidates = findHighCoverageTranscripts();
  console.log(`Found ${candidates.length} high-coverage transcripts\n`);

  if (candidates.length === 0) {
    console.log('No transcripts meet the 60% coverage threshold.');
    return;
  }

  const results = [];

  for (const c of candidates) {
    console.log('-'.repeat(100));
    console.log(`\nTranscript: ${path.basename(c.path)}`);
    console.log(`Observation coverage: ${(c.matchRate * 100).toFixed(0)}% (${c.matches}/${c.total} tool results)`);
    console.log();

    const analysis = await analyzeTranscriptRolling(c.path);
    if (!analysis) {
      console.log('Insufficient data for analysis\n');
      continue;
    }

    results.push(analysis);

    // Show rolling table (first 10 + last 5 if many)
    console.log('Turn │ Tool        │ Ctrl Bytes │ Comp Bytes │ Has Obs │ ×Calls │ Cum Ctrl Power │ Cum Comp Power');
    console.log('─────┼─────────────┼────────────┼────────────┼─────────┼────────┼────────────────┼────────────────');

    const r = analysis.rolling;
    const showAll = r.length <= 15;
    const toShow = showAll ? r : [...r.slice(0, 10), null, ...r.slice(-5)];

    for (const item of toShow) {
      if (item === null) {
        console.log('  …  │     …       │     …      │     …      │    …    │   …    │       …        │       …');
        continue;
      }
      const obsMarker = item.hasObs ? '✓' : ' ';
      console.log(
        String(item.order).padStart(4) + ' │ ' +
        item.tool.slice(0, 11).padEnd(11) + ' │ ' +
        fmtBytes(item.ctrlBytes).padStart(10) + ' │ ' +
        fmtBytes(item.compBytes).padStart(10) + ' │ ' +
        obsMarker.padStart(4) + '    │ ' +
        String(item.subsequentCalls).padStart(5) + '  │ ' +
        fmtBytes(item.cumCtrlPower).padStart(14) + ' │ ' +
        fmtBytes(item.cumCompPower).padStart(14)
      );
    }

    console.log();
    console.log('Final Results:');
    console.log(`  Control tokens:    ${fmtNum(analysis.finalCtrlTokens)} bytes`);
    console.log(`  Compressed tokens: ${fmtNum(analysis.finalCompTokens)} bytes`);
    console.log(`  Token reduction:   ${analysis.tokenReduction}%`);
    console.log();
    console.log(`  Control power:     ${fmtBytes(analysis.finalCtrlPower)}`);
    console.log(`  Compressed power:  ${fmtBytes(analysis.finalCompPower)}`);
    console.log(`  Power reduction:   ${analysis.powerReduction}%`);
    console.log();
  }

  // Summary across all high-coverage transcripts
  if (results.length > 1) {
    console.log('='.repeat(100));
    console.log('AGGREGATE SUMMARY (High-Coverage Transcripts Only)');
    console.log('='.repeat(100));
    console.log();

    console.log('Transcript'.padEnd(40) + ' Match% │ Token Red. │ Power Red.');
    console.log('─'.repeat(40) + '─┼────────────┼────────────');

    for (const r of results) {
      console.log(
        r.filename.slice(0, 38).padEnd(40) +
        (r.matchRate * 100).toFixed(0).padStart(4) + '% │ ' +
        (r.tokenReduction + '%').padStart(10) + ' │ ' +
        (r.powerReduction + '%').padStart(10)
      );
    }

    const totalCtrlTokens = results.reduce((s, r) => s + r.finalCtrlTokens, 0);
    const totalCompTokens = results.reduce((s, r) => s + r.finalCompTokens, 0);
    const totalCtrlPower = results.reduce((s, r) => s + r.finalCtrlPower, 0);
    const totalCompPower = results.reduce((s, r) => s + r.finalCompPower, 0);

    console.log('─'.repeat(40) + '─┼────────────┼────────────');
    console.log(
      'TOTAL'.padEnd(40) +
      '     │ ' +
      (((totalCtrlTokens - totalCompTokens) / totalCtrlTokens * 100).toFixed(1) + '%').padStart(10) + ' │ ' +
      (((totalCtrlPower - totalCompPower) / totalCtrlPower * 100).toFixed(1) + '%').padStart(10)
    );

    console.log();
    console.log(`Control tokens total:    ${fmtNum(totalCtrlTokens)} bytes (${fmtBytes(totalCtrlTokens)})`);
    console.log(`Compressed tokens total: ${fmtNum(totalCompTokens)} bytes (${fmtBytes(totalCompTokens)})`);
    console.log(`Control power total:     ${fmtBytes(totalCtrlPower)}`);
    console.log(`Compressed power total:  ${fmtBytes(totalCompPower)}`);
    console.log();
    console.log(`Overall token reduction: ${((totalCtrlTokens - totalCompTokens) / totalCtrlTokens * 100).toFixed(1)}%`);
    console.log(`Overall power reduction: ${((totalCtrlPower - totalCompPower) / totalCtrlPower * 100).toFixed(1)}%`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
