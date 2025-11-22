#!/usr/bin/env node

import fs from 'fs';
import readline from 'readline';

const TRANSCRIPT_PATH = process.argv[2] || '/Users/alexnewman/.claude/projects/-Users-alexnewman-Scripts-claude-mem/agent-e41f2b47.jsonl';

async function analyzeTranscript() {
  console.log(`Analyzing: ${TRANSCRIPT_PATH}\n`);

  const fileStream = fs.createReadStream(TRANSCRIPT_PATH);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const lineSizes = [];
  let lineNum = 0;

  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;

    try {
      const obj = JSON.parse(line);
      const size = line.length;

      // Categorize the line
      let category = 'other';
      let details = '';

      if (obj.type === 'assistant' && obj.message?.content) {
        for (const item of obj.message.content) {
          if (item.type === 'tool_use') {
            if (item.input?._compressed) {
              category = 'tool_use_compressed';
              details = `${item.name} (compressed: ${item.input._compressed.length} chars)`;
            } else {
              category = 'tool_use_original';
              details = `${item.name} (original: ${JSON.stringify(item.input).length} chars)`;
            }
          } else if (item.type === 'text') {
            category = 'assistant_text';
            details = `text (${item.text?.length || 0} chars)`;
          }
        }
      } else if (obj.type === 'user' && obj.message?.content) {
        for (const item of obj.message.content) {
          if (item.type === 'tool_result') {
            const isCompressed = typeof item.content === 'string' && !item.content.startsWith('[') && !item.content.startsWith('{');
            if (isCompressed) {
              category = 'tool_result_compressed';
              details = `tool_result (compressed: ${item.content.length} chars)`;
            } else {
              category = 'tool_result_original';
              const contentSize = typeof item.content === 'string' ? item.content.length : JSON.stringify(item.content).length;
              details = `tool_result (original: ${contentSize} chars)`;
            }
          } else if (item.type === 'text') {
            category = 'user_text';
            details = `text (${item.text?.length || 0} chars)`;
          }
        }
      } else if (obj.toolUseResult) {
        category = 'tool_use_result_wrapper';
        details = `agentId: ${obj.toolUseResult.agentId || 'none'}`;
      }

      lineSizes.push({ lineNum, size, category, details, obj });
    } catch (e) {
      console.error(`Error parsing line ${lineNum}: ${e.message}`);
    }
  }

  // Sort by size descending
  lineSizes.sort((a, b) => b.size - a.size);

  // Summary by category
  const categoryTotals = {};
  lineSizes.forEach(({ category, size }) => {
    categoryTotals[category] = (categoryTotals[category] || 0) + size;
  });

  console.log('='.repeat(100));
  console.log('SIZE BY CATEGORY');
  console.log('='.repeat(100));

  const sorted = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]);
  sorted.forEach(([cat, total]) => {
    const pct = ((total / fs.statSync(TRANSCRIPT_PATH).size) * 100).toFixed(1);
    console.log(`${cat.padEnd(30)} ${total.toLocaleString().padStart(10)} bytes (${pct}%)`);
  });

  const totalSize = fs.statSync(TRANSCRIPT_PATH).size;
  console.log(`${'TOTAL'.padEnd(30)} ${totalSize.toLocaleString().padStart(10)} bytes`);
  console.log();

  // Top 20 largest lines
  console.log('='.repeat(100));
  console.log('TOP 20 LARGEST LINES');
  console.log('='.repeat(100));
  console.log('Line#    Size      Category                    Details');
  console.log('-'.repeat(100));

  lineSizes.slice(0, 20).forEach(({ lineNum, size, category, details }) => {
    console.log(`${String(lineNum).padStart(5)}    ${size.toLocaleString().padStart(8)}  ${category.padEnd(28)} ${details}`);
  });

  console.log('='.repeat(100));
}

analyzeTranscript().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
