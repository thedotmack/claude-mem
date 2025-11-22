#!/usr/bin/env node

import fs from 'fs';
import Database from 'better-sqlite3';
import readline from 'readline';

// Configuration
const ANALYSIS_JSON = '/tmp/tool-use-analysis.json';
const JSONL_PATH = '/Users/alexnewman/.claude/projects/-Users-alexnewman-Scripts-DuhPaper/f11b0170-6157-4324-a479-66c35686eb69.jsonl';
const AGENT_FILES = [
  '/Users/alexnewman/.claude/projects/-Users-alexnewman-Scripts-DuhPaper/agent-f50e2819.jsonl'
];
const DB_PATH = '/Users/alexnewman/.claude-mem/claude-mem.db';

// Load analysis data to get tool use IDs
console.log('Loading tool use IDs from analysis...');
const analysis = JSON.parse(fs.readFileSync(ANALYSIS_JSON, 'utf-8'));
const toolUseIds = analysis.summary.allToolUseIds;
console.log(`Found ${toolUseIds.length} unique tool use IDs\n`);

// Map to store original content from transcript (both inputs and outputs)
const originalContent = new Map();

// Parse transcript to get BOTH tool_use (inputs) and tool_result (outputs) content
async function loadOriginalContentFromFile(filePath, fileLabel) {
  console.log(`Loading original content from ${fileLabel}...`);

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let count = 0;

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
            count++;
          }

          // Capture tool_result (outputs)
          if (item.type === 'tool_result' && item.tool_use_id) {
            const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
            const existing = originalContent.get(item.tool_use_id) || { input: '', output: '', name: '' };
            existing.output = content;
            originalContent.set(item.tool_use_id, existing);
          }
        }
      }
    } catch (e) {
      // Skip malformed lines
    }
  }

  console.log(`  → Found ${count} tool uses in ${fileLabel}`);
}

async function loadOriginalContent() {
  console.log('Loading original content from transcripts...');

  // Load from main transcript
  await loadOriginalContentFromFile(JSONL_PATH, 'main transcript');

  // Load from agent files
  for (const agentFile of AGENT_FILES) {
    if (fs.existsSync(agentFile)) {
      await loadOriginalContentFromFile(agentFile, `agent transcript (${agentFile.split('/').pop()})`);
    }
  }

  console.log(`\nTotal: Loaded original content for ${originalContent.size} tool uses (inputs + outputs)\n`);
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
      narrative
    FROM observations
    WHERE tool_use_id IN (${placeholders})
    ORDER BY created_at DESC
  `;

  const observations = db.prepare(query).all(...toolUseIds);
  db.close();

  console.log(`Found ${observations.length} observations matching tool use IDs\n`);

  return observations;
}

// Smart transformation logic: INPUT first, then OUTPUT if input didn't work
function analyzeTransformations(observations) {
  console.log('='.repeat(110));
  console.log('SMART TRANSFORMATION ANALYSIS');
  console.log('='.repeat(110));
  console.log();

  // Group observations by tool_use_id
  const obsByToolId = new Map();
  observations.forEach(obs => {
    if (!obsByToolId.has(obs.tool_use_id)) {
      obsByToolId.set(obs.tool_use_id, []);
    }
    obsByToolId.get(obs.tool_use_id).push(obs);
  });

  const transformations = {
    input: [],
    output: [],
    none: []
  };

  let totalInputSaved = 0;
  let totalOutputSaved = 0;

  console.log('TRANSFORMATION DECISIONS');
  console.log('-'.repeat(110));
  console.log('Tool Use ID                          Tool Name          Input    Output    Obs(best)  Decision        Savings');
  console.log('-'.repeat(110));

  // Analyze each tool use
  obsByToolId.forEach((obsArray, toolUseId) => {
    const original = originalContent.get(toolUseId);
    const inputLen = original?.input?.length || 0;
    const outputLen = original?.output?.length || 0;
    const toolName = original?.name || 'unknown';

    // Find best observation (smallest narrative)
    let bestObs = null;
    let bestObsLen = Infinity;

    obsArray.forEach(obs => {
      const obsLen = obs.narrative?.length || 0;
      if (obsLen > 0 && obsLen < bestObsLen) {
        bestObs = obs;
        bestObsLen = obsLen;
      }
    });

    if (!bestObs) {
      transformations.none.push({ tool_use_id: toolUseId, tool_name: toolName, reason: 'no valid observation' });
      console.log(
        `${toolUseId.padEnd(36)} ${toolName.padEnd(18)} ${String(inputLen).padStart(8)} ${String(outputLen).padStart(9)} ${String(0).padStart(10)}  NONE (no obs)   ${String(0).padStart(8)}`
      );
      return;
    }

    // Decision logic: Try INPUT first, then OUTPUT
    let decision = 'NONE';
    let savings = 0;

    if (inputLen > 0 && bestObsLen < inputLen) {
      // Transform INPUT
      decision = 'INPUT';
      savings = inputLen - bestObsLen;
      totalInputSaved += savings;
      transformations.input.push({
        tool_use_id: toolUseId,
        tool_name: toolName,
        input_len: inputLen,
        obs_len: bestObsLen,
        savings,
        reduction: ((savings / inputLen) * 100).toFixed(1)
      });
    } else if (outputLen > 0 && bestObsLen < outputLen) {
      // Transform OUTPUT (only if INPUT wasn't transformed)
      decision = 'OUTPUT';
      savings = outputLen - bestObsLen;
      totalOutputSaved += savings;
      transformations.output.push({
        tool_use_id: toolUseId,
        tool_name: toolName,
        output_len: outputLen,
        obs_len: bestObsLen,
        savings,
        reduction: ((savings / outputLen) * 100).toFixed(1)
      });
    } else {
      // No transformation
      transformations.none.push({
        tool_use_id: toolUseId,
        tool_name: toolName,
        reason: `obs(${bestObsLen}) >= input(${inputLen}) and output(${outputLen})`
      });
    }

    console.log(
      `${toolUseId.padEnd(36)} ${toolName.padEnd(18)} ${String(inputLen).padStart(8)} ${String(outputLen).padStart(9)} ${String(bestObsLen).padStart(10)}  ${decision.padEnd(14)}  ${String(savings).padStart(8)}`
    );
  });

  console.log('-'.repeat(110));
  console.log();

  // Summary
  console.log('SUMMARY');
  console.log('-'.repeat(110));
  console.log(`Total unique tool uses analyzed:     ${obsByToolId.size}`);
  console.log(`INPUT transformations:               ${transformations.input.length}`);
  console.log(`OUTPUT transformations:              ${transformations.output.length}`);
  console.log(`No transformation:                   ${transformations.none.length}`);
  console.log();
  console.log(`Total INPUT characters saved:        ${totalInputSaved.toLocaleString()}`);
  console.log(`Total OUTPUT characters saved:       ${totalOutputSaved.toLocaleString()}`);
  console.log(`TOTAL characters saved:              ${(totalInputSaved + totalOutputSaved).toLocaleString()}`);
  console.log();

  // Top transformations
  if (transformations.input.length > 0) {
    console.log('TOP INPUT TRANSFORMATIONS (by % reduction):');
    console.log('-'.repeat(110));
    const topInput = transformations.input.sort((a, b) => parseFloat(b.reduction) - parseFloat(a.reduction)).slice(0, 10);
    topInput.forEach((t, i) => {
      console.log(`${String(i + 1).padStart(2)}. ${t.tool_use_id} (${t.tool_name}): ${t.input_len} → ${t.obs_len} chars (${t.reduction}% reduction, ${t.savings} saved)`);
    });
    console.log();
  }

  if (transformations.output.length > 0) {
    console.log('TOP OUTPUT TRANSFORMATIONS (by % reduction):');
    console.log('-'.repeat(110));
    const topOutput = transformations.output.sort((a, b) => parseFloat(b.reduction) - parseFloat(a.reduction)).slice(0, 10);
    topOutput.forEach((t, i) => {
      console.log(`${String(i + 1).padStart(2)}. ${t.tool_use_id} (${t.tool_name}): ${t.output_len} → ${t.obs_len} chars (${t.reduction}% reduction, ${t.savings} saved)`);
    });
    console.log();
  }

  console.log('='.repeat(110));
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
