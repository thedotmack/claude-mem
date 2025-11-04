#!/usr/bin/env node
/**
 * Analyze usage logs from ~/.claude-mem/usage-logs/
 *
 * Usage:
 *   node scripts/analyze-usage.js [date]
 *
 * Example:
 *   node scripts/analyze-usage.js 2025-11-03
 *   node scripts/analyze-usage.js           # Uses today's date
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const usageDir = join(homedir(), '.claude-mem', 'usage-logs');

// Get date from command line or use today
const targetDate = process.argv[2] || new Date().toISOString().split('T')[0];
const filename = `usage-${targetDate}.jsonl`;
const filepath = join(usageDir, filename);

console.log(`\n📊 Usage Analysis for ${targetDate}\n`);
console.log(`Reading from: ${filepath}\n`);

try {
  const content = readFileSync(filepath, 'utf-8');
  const lines = content.trim().split('\n');

  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  const projectStats = {};
  const modelStats = {};

  lines.forEach(line => {
    if (!line.trim()) return;

    try {
      const entry = JSON.parse(line);

      // Aggregate totals
      totalCost += entry.totalCostUsd || 0;
      totalInputTokens += entry.usage?.inputTokens || 0;
      totalOutputTokens += entry.usage?.outputTokens || 0;
      totalCacheCreation += entry.usage?.cacheCreationInputTokens || 0;
      totalCacheRead += entry.usage?.cacheReadInputTokens || 0;

      // Project stats
      if (!projectStats[entry.project]) {
        projectStats[entry.project] = {
          cost: 0,
          sessions: new Set(),
          tokens: 0
        };
      }
      projectStats[entry.project].cost += entry.totalCostUsd || 0;
      projectStats[entry.project].sessions.add(entry.sessionDbId);
      projectStats[entry.project].tokens += (entry.usage?.inputTokens || 0) + (entry.usage?.outputTokens || 0);

      // Model stats
      if (!modelStats[entry.model]) {
        modelStats[entry.model] = {
          cost: 0,
          calls: 0,
          tokens: 0
        };
      }
      modelStats[entry.model].cost += entry.totalCostUsd || 0;
      modelStats[entry.model].calls += 1;
      modelStats[entry.model].tokens += (entry.usage?.inputTokens || 0) + (entry.usage?.outputTokens || 0);

    } catch (e) {
      console.error(`Error parsing line: ${e.message}`);
    }
  });

  // Print summary
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`📈 Total Cost: $${totalCost.toFixed(4)}`);
  console.log(`📊 Total API Calls: ${lines.length}`);
  console.log(`\n🎯 Token Usage:`);
  console.log(`   Input Tokens:              ${totalInputTokens.toLocaleString()}`);
  console.log(`   Output Tokens:             ${totalOutputTokens.toLocaleString()}`);
  console.log(`   Cache Creation Tokens:     ${totalCacheCreation.toLocaleString()}`);
  console.log(`   Cache Read Tokens:         ${totalCacheRead.toLocaleString()}`);
  console.log(`   Total Tokens:              ${(totalInputTokens + totalOutputTokens).toLocaleString()}`);

  if (totalCacheRead > 0) {
    const savings = ((totalCacheRead / (totalInputTokens + totalCacheRead)) * 100).toFixed(1);
    console.log(`   Cache Hit Rate:            ${savings}%`);
  }

  console.log(`\n📁 By Project:`);
  Object.entries(projectStats)
    .sort((a, b) => b[1].cost - a[1].cost)
    .forEach(([project, stats]) => {
      console.log(`   ${project}:`);
      console.log(`      Cost: $${stats.cost.toFixed(4)}`);
      console.log(`      Sessions: ${stats.sessions.size}`);
      console.log(`      Tokens: ${stats.tokens.toLocaleString()}`);
    });

  console.log(`\n🤖 By Model:`);
  Object.entries(modelStats)
    .sort((a, b) => b[1].cost - a[1].cost)
    .forEach(([model, stats]) => {
      console.log(`   ${model}:`);
      console.log(`      Cost: $${stats.cost.toFixed(4)}`);
      console.log(`      Calls: ${stats.calls}`);
      console.log(`      Tokens: ${stats.tokens.toLocaleString()}`);
      console.log(`      Avg Cost/Call: $${(stats.cost / stats.calls).toFixed(4)}`);
    });

  console.log('\n═══════════════════════════════════════════════════════════\n');

} catch (error) {
  if (error.code === 'ENOENT') {
    console.error(`❌ No usage log found for ${targetDate}`);
    console.log(`\nAvailable logs:`);
    try {
      const files = readdirSync(usageDir).filter(f => f.endsWith('.jsonl'));
      files.forEach(f => console.log(`   - ${f}`));
    } catch (e) {
      console.error(`   Could not read usage logs directory`);
    }
  } else {
    console.error(`❌ Error: ${error.message}`);
  }
  process.exit(1);
}
