#!/usr/bin/env node

/**
 * Endless Mode Token Economics Calculator
 *
 * Usage: node endless-mode-token-calculator.js <observation_id>
 *
 * Takes an observation ID, finds its session, and calculates token savings
 * for that entire session by comparing WITH and WITHOUT Endless Mode.
 *
 * Key Insight:
 * - Discovery tokens are ALWAYS spent (creating observations)
 * - But Endless Mode feeds compressed observations as context instead of full tool outputs
 * - Savings compound recursively - each tool benefits from ALL previous compressions
 */

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';

const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');

// Get mode from command line
const mode = process.argv[2];
const observationId = process.argv[3];
const noTruncate = process.argv.includes('--no-truncate');

// Open database
const db = new Database(DB_PATH, { readonly: true });

let sessionsToAnalyze = [];

if (mode === '--all') {
  // Get all sessions that have observations with discovery_tokens
  const sessions = db.prepare(`
    SELECT DISTINCT sdk_session_id
    FROM observations
    WHERE discovery_tokens IS NOT NULL AND discovery_tokens > 0
    ORDER BY created_at_epoch ASC
  `).all();

  if (sessions.length === 0) {
    console.error('❌ No sessions found with discovery_tokens');
    db.close();
    process.exit(1);
  }

  sessionsToAnalyze = sessions.map(s => s.sdk_session_id);
  console.log(`\n📊 Analyzing ${sessionsToAnalyze.length} sessions with discovery_tokens...\n`);

} else if (mode && !mode.startsWith('--')) {
  // Original behavior: single observation ID
  const obsId = mode; // First arg is the observation ID
  const observation = db.prepare(`
    SELECT sdk_session_id, id, title
    FROM observations
    WHERE id = ?
  `).get(obsId);

  if (!observation) {
    console.error(`❌ Observation ${obsId} not found`);
    db.close();
    process.exit(1);
  }

  sessionsToAnalyze = [observation.sdk_session_id];
  console.log(`\n📍 Analyzing session from observation #${observation.id}: "${observation.title}"\n`);

} else {
  console.error('Usage:');
  console.error('  node endless-mode-token-calculator.js <observation_id>');
  console.error('  node endless-mode-token-calculator.js --all [--no-truncate]');
  console.error('');
  console.error('Options:');
  console.error('  --no-truncate    Show full observation titles without truncation');
  console.error('');
  console.error('Examples:');
  console.error('  node endless-mode-token-calculator.js 10136');
  console.error('  node endless-mode-token-calculator.js --all');
  console.error('  node endless-mode-token-calculator.js --all --no-truncate');
  process.exit(1);
}

// Use discovery tokens as proxy for original tool output size
// Discovery cost is proportional to output complexity: bigger output = more tokens to analyze
function estimateOriginalToolOutputSize(discoveryTokens) {
  return discoveryTokens;
}

// Convert compressed_size (character count) to approximate token count
// Rough heuristic: 1 token ≈ 4 characters for English text
function charsToTokens(chars) {
  return Math.ceil(chars / 4);
}

/**
 * Simulate session WITHOUT Endless Mode (current behavior)
 * Each continuation carries ALL previous full tool outputs in context
 */
function calculateWithoutEndlessMode(observations) {
  let cumulativeContextTokens = 0;
  let totalDiscoveryTokens = 0;
  let totalContinuationTokens = 0;
  const timeline = [];

  observations.forEach((obs, index) => {
    const toolNumber = index + 1;
    const originalToolSize = estimateOriginalToolOutputSize(obs.discovery_tokens);

    // Discovery cost (creating observation from full tool output)
    const discoveryCost = obs.discovery_tokens;
    totalDiscoveryTokens += discoveryCost;

    // Continuation cost: Re-process ALL previous tool outputs + current one
    // This is the key recursive cost
    cumulativeContextTokens += originalToolSize;
    const continuationCost = cumulativeContextTokens;
    totalContinuationTokens += continuationCost;

    timeline.push({
      tool: toolNumber,
      obsId: obs.id,
      title: (obs.title || 'Untitled').substring(0, 60),
      originalSize: originalToolSize,
      discoveryCost,
      contextSize: cumulativeContextTokens,
      continuationCost,
      totalCostSoFar: totalDiscoveryTokens + totalContinuationTokens
    });
  });

  // Calculate non-compounded total (just sum of all tool outputs, no accumulation)
  const nonCompoundedTotal = observations.reduce((sum, obs) => {
    return sum + estimateOriginalToolOutputSize(obs.discovery_tokens);
  }, 0);

  return {
    totalDiscoveryTokens,
    totalContinuationTokens,
    totalTokens: totalDiscoveryTokens + totalContinuationTokens,
    nonCompoundedTotal: totalDiscoveryTokens + nonCompoundedTotal,
    timeline
  };
}

/**
 * Simulate session WITH Endless Mode
 * Each continuation carries ALL previous COMPRESSED observations in context
 */
function calculateWithEndlessMode(observations) {
  let cumulativeContextTokens = 0;
  let totalDiscoveryTokens = 0;
  let totalContinuationTokens = 0;
  const timeline = [];

  observations.forEach((obs, index) => {
    const toolNumber = index + 1;
    const originalToolSize = estimateOriginalToolOutputSize(obs.discovery_tokens);
    const compressedSize = charsToTokens(obs.compressed_size);

    // Discovery cost (same as without Endless Mode - still need to create observation)
    const discoveryCost = obs.discovery_tokens;
    totalDiscoveryTokens += discoveryCost;

    // KEY DIFFERENCE: Add COMPRESSED size to context, not original size
    cumulativeContextTokens += compressedSize;
    const continuationCost = cumulativeContextTokens;
    totalContinuationTokens += continuationCost;

    const compressionRatio = ((originalToolSize - compressedSize) / originalToolSize * 100).toFixed(1);

    timeline.push({
      tool: toolNumber,
      obsId: obs.id,
      title: (obs.title || 'Untitled').substring(0, 60),
      originalSize: originalToolSize,
      compressedSize,
      compressionRatio: `${compressionRatio}%`,
      discoveryCost,
      contextSize: cumulativeContextTokens,
      continuationCost,
      totalCostSoFar: totalDiscoveryTokens + totalContinuationTokens
    });
  });

  // Calculate non-compounded total (just sum of all compressed observations, no accumulation)
  const nonCompoundedTotal = observations.reduce((sum, obs) => {
    return sum + charsToTokens(obs.compressed_size);
  }, 0);

  return {
    totalDiscoveryTokens,
    totalContinuationTokens,
    totalTokens: totalDiscoveryTokens + totalContinuationTokens,
    nonCompoundedTotal: totalDiscoveryTokens + nonCompoundedTotal,
    timeline
  };
}

/**
 * Play the tape through - show token-by-token progression
 */
function playTheTapeThrough(observations) {
  console.log('\n' + '='.repeat(100));
  console.log('ENDLESS MODE TOKEN ECONOMICS CALCULATOR');
  console.log('Playing the tape through with REAL observation data');
  console.log('='.repeat(100) + '\n');

  console.log(`📊 Dataset: ${observations.length} observations from live sessions\n`);

  // Calculate both scenarios
  const without = calculateWithoutEndlessMode(observations);
  const withMode = calculateWithEndlessMode(observations);

  // Show first 10 tools from each scenario side by side
  console.log('🎬 TAPE PLAYBACK: First 10 Tools\n');
  console.log('WITHOUT Endless Mode (Current) | WITH Endless Mode (Proposed)');
  console.log('-'.repeat(100));

  for (let i = 0; i < Math.min(10, observations.length); i++) {
    const w = without.timeline[i];
    const e = withMode.timeline[i];

    console.log(`\nTool #${w.tool}: ${w.title}`);
    console.log(`  Original: ${w.originalSize.toLocaleString()}t | Compressed: ${e.compressedSize.toLocaleString()}t (${e.compressionRatio} saved)`);
    console.log(`  Context:  ${w.contextSize.toLocaleString()}t | Context:    ${e.contextSize.toLocaleString()}t`);
    console.log(`  Total:    ${w.totalCostSoFar.toLocaleString()}t | Total:      ${e.totalCostSoFar.toLocaleString()}t`);
  }

  // Summary table
  console.log('\n' + '='.repeat(100));
  console.log('📈 FINAL TOTALS\n');

  console.log('WITHOUT Endless Mode (Current):');
  console.log(`  Discovery tokens:    ${without.totalDiscoveryTokens.toLocaleString()}t (creating observations)`);
  console.log(`  Continuation tokens: ${without.totalContinuationTokens.toLocaleString()}t (context accumulation)`);
  console.log(`  TOTAL TOKENS:        ${without.totalTokens.toLocaleString()}t`);

  console.log('\nWITH Endless Mode:');
  console.log(`  Discovery tokens:    ${withMode.totalDiscoveryTokens.toLocaleString()}t (same - still create observations)`);
  console.log(`  Continuation tokens: ${withMode.totalContinuationTokens.toLocaleString()}t (COMPRESSED context)`);
  console.log(`  TOTAL TOKENS:        ${withMode.totalTokens.toLocaleString()}t`);

  const tokensSaved = without.totalTokens - withMode.totalTokens;
  const percentSaved = (tokensSaved / without.totalTokens * 100).toFixed(1);

  console.log('\n💰 SAVINGS:');
  console.log(`  Tokens saved:        ${tokensSaved.toLocaleString()}t`);
  console.log(`  Percentage saved:    ${percentSaved}%`);
  console.log(`  Efficiency gain:     ${(without.totalTokens / withMode.totalTokens).toFixed(2)}x`);

  // Anthropic scale calculation
  console.log('\n' + '='.repeat(100));
  console.log('🌍 ANTHROPIC SCALE IMPACT\n');

  // Conservative assumptions
  const activeUsers = 100000; // Claude Code users
  const sessionsPerWeek = 10; // Per user
  const toolsPerSession = observations.length; // Use our actual data
  const weeklyToolUses = activeUsers * sessionsPerWeek * toolsPerSession;

  const avgTokensPerToolWithout = without.totalTokens / observations.length;
  const avgTokensPerToolWith = withMode.totalTokens / observations.length;

  const weeklyTokensWithout = weeklyToolUses * avgTokensPerToolWithout;
  const weeklyTokensWith = weeklyToolUses * avgTokensPerToolWith;
  const weeklyTokensSaved = weeklyTokensWithout - weeklyTokensWith;

  console.log('Assumptions:');
  console.log(`  Active Claude Code users:  ${activeUsers.toLocaleString()}`);
  console.log(`  Sessions per user/week:    ${sessionsPerWeek}`);
  console.log(`  Tools per session:         ${toolsPerSession}`);
  console.log(`  Weekly tool uses:          ${weeklyToolUses.toLocaleString()}`);

  console.log('\nWeekly Compute:');
  console.log(`  Without Endless Mode:      ${(weeklyTokensWithout / 1e9).toFixed(2)} billion tokens`);
  console.log(`  With Endless Mode:         ${(weeklyTokensWith / 1e9).toFixed(2)} billion tokens`);
  console.log(`  Weekly savings:            ${(weeklyTokensSaved / 1e9).toFixed(2)} billion tokens (${percentSaved}%)`);

  const annualTokensSaved = weeklyTokensSaved * 52;
  console.log(`  Annual savings:            ${(annualTokensSaved / 1e12).toFixed(2)} TRILLION tokens`);

  console.log('\n💡 What this means:');
  console.log(`  • ${percentSaved}% reduction in Claude Code inference costs`);
  console.log(`  • ${(without.totalTokens / withMode.totalTokens).toFixed(1)}x more users served with same infrastructure`);
  console.log(`  • Massive energy/compute savings at scale`);
  console.log(`  • Longer sessions = better UX without economic penalty`);

  console.log('\n' + '='.repeat(100) + '\n');

  return {
    without,
    withMode,
    tokensSaved,
    percentSaved,
    weeklyTokensSaved,
    annualTokensSaved
  };
}

// Run calculations for all sessions
let aggregateResults = {
  totalSessions: 0,
  totalObservations: 0,
  totalDiscoveryTokens: 0,
  totalContinuationTokensWithout: 0,
  totalContinuationTokensWith: 0,
  totalTokensWithout: 0,
  totalTokensWith: 0,
  nonCompoundedWithout: 0,
  nonCompoundedWith: 0
};

const sessionResults = []; // Store per-session results for table

for (const sessionId of sessionsToAnalyze) {
  // Get all observations from this session
  const observationsData = db.prepare(`
    SELECT
      id,
      type,
      title,
      discovery_tokens,
      created_at_epoch,
      (
        COALESCE(LENGTH(title), 0) +
        COALESCE(LENGTH(subtitle), 0) +
        COALESCE(LENGTH(narrative), 0) +
        COALESCE(LENGTH(facts), 0) +
        COALESCE(LENGTH(concepts), 0) +
        COALESCE(LENGTH(files_read), 0) +
        COALESCE(LENGTH(files_modified), 0)
      ) as compressed_size
    FROM observations
    WHERE sdk_session_id = ?
      AND discovery_tokens IS NOT NULL
      AND discovery_tokens > 0
    ORDER BY created_at_epoch ASC
  `).all(sessionId);

  if (observationsData.length === 0) continue;

  // Get session summary if it exists
  const summary = db.prepare(`
    SELECT request, created_at
    FROM session_summaries
    WHERE sdk_session_id = ?
    ORDER BY created_at_epoch DESC
    LIMIT 1
  `).get(sessionId);

  // Check if this session has Endless Mode enabled
  // Search across all project folders for the transcript
  let hasEndlessMode = false;
  try {
    const projectsDir = join(homedir(), '.claude', 'projects');
    if (existsSync(projectsDir)) {
      const projectFolders = readdirSync(projectsDir);

      for (const projectFolder of projectFolders) {
        const transcriptPath = join(projectsDir, projectFolder, `${sessionId}.jsonl`);
        if (existsSync(transcriptPath)) {
          const transcriptContent = readFileSync(transcriptPath, 'utf-8');
          if (transcriptContent.includes('Compressed by Endless Mode')) {
            hasEndlessMode = true;
            break;
          }
        }
      }
    }
  } catch (e) {
    // Transcript not found or error reading - assume no Endless Mode
  }

  if (mode === '--all') {
    // Aggregate mode: accumulate totals and store per-session results
    const without = calculateWithoutEndlessMode(observationsData);
    const withMode = calculateWithEndlessMode(observationsData);

    const tokensSaved = without.totalTokens - withMode.totalTokens;
    const percentSaved = (tokensSaved / without.totalTokens * 100).toFixed(1);

    // Format date/time
    let dateStr = '';
    if (summary) {
      const date = new Date(summary.created_at);
      dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    // Use first observation title instead of session summary
    const firstObsTitle = observationsData[0]?.title || 'Untitled';

    sessionResults.push({
      sessionId: sessionId.substring(0, 8), // Short ID for table
      date: dateStr,
      summary: firstObsTitle,
      obsCount: observationsData.length,
      discoveryTokens: without.totalDiscoveryTokens,
      withoutTotal: without.totalTokens,
      withTotal: withMode.totalTokens,
      withoutUserVisible: without.nonCompoundedTotal,
      withUserVisible: withMode.nonCompoundedTotal,
      saved: tokensSaved,
      percent: percentSaved,
      endless: hasEndlessMode
    });

    aggregateResults.totalSessions++;
    aggregateResults.totalObservations += observationsData.length;
    aggregateResults.totalDiscoveryTokens += without.totalDiscoveryTokens;
    aggregateResults.totalContinuationTokensWithout += without.totalContinuationTokens;
    aggregateResults.totalContinuationTokensWith += withMode.totalContinuationTokens;
    aggregateResults.totalTokensWithout += without.totalTokens;
    aggregateResults.totalTokensWith += withMode.totalTokens;
    aggregateResults.nonCompoundedWithout += without.nonCompoundedTotal;
    aggregateResults.nonCompoundedWith += withMode.nonCompoundedTotal;
  } else {
    // Single session mode: show detailed output
    playTheTapeThrough(observationsData);
  }
}

// Show aggregate results for --all mode
if (mode === '--all') {
  const tokensSaved = aggregateResults.totalTokensWithout - aggregateResults.totalTokensWith;
  const percentSaved = (tokensSaved / aggregateResults.totalTokensWithout * 100).toFixed(1);
  const efficiencyGain = (aggregateResults.totalTokensWithout / aggregateResults.totalTokensWith).toFixed(2);

  console.log('='.repeat(210));
  console.log('PER-SESSION BREAKDOWN');
  console.log('='.repeat(210) + '\n');

  // Table header - dynamic width for summary column
  const summaryWidth = noTruncate ? 80 : 36;
  const summaryHeader = 'First Observation Title'.padEnd(summaryWidth);
  console.log(`Date      | Session  | ${summaryHeader} | Obs | EM | User-Visible  | User-Visible  | Processing    | Processing    | Saved  | %     `);
  console.log(`          |          | ${' '.repeat(summaryWidth)} |     |    | (Without)     | (With)        | (Without)     | (With)        |        |       `);
  console.log(`----------|----------|${'-'.repeat(summaryWidth)}--|-----|-------|---------------|---------------|---------------|---------------|--------|-------`);

  // Table rows
  for (const session of sessionResults) {
    const date = (session.date || '').padEnd(9);
    const sessionId = session.sessionId.padEnd(8);
    const summaryText = session.summary || 'Untitled';
    const summary = noTruncate
      ? summaryText.padEnd(summaryWidth)
      : summaryText.substring(0, summaryWidth).padEnd(summaryWidth);
    const obsCount = String(session.obsCount).padStart(3);
    const endlessMode = session.endless ? ' ✓ ' : '   ';
    const userVisWithout = session.withoutUserVisible.toLocaleString().padStart(13);
    const userVisWith = session.withUserVisible.toLocaleString().padStart(13);
    const procWithout = session.withoutTotal.toLocaleString().padStart(13);
    const procWith = session.withTotal.toLocaleString().padStart(13);
    const saved = session.saved.toLocaleString().padStart(6);
    const percent = String(session.percent).padStart(5);

    console.log(`${date} | ${sessionId} | ${summary} | ${obsCount} | ${endlessMode} | ${userVisWithout} | ${userVisWith} | ${procWithout} | ${procWith} | ${saved} | ${percent}%`);
  }

  console.log('');
  console.log('='.repeat(120));
  console.log('AGGREGATE RESULTS ACROSS ALL SESSIONS');
  console.log('='.repeat(120) + '\n');

  console.log(`📊 Total Sessions Analyzed: ${aggregateResults.totalSessions}`);
  console.log(`📊 Total Observations: ${aggregateResults.totalObservations.toLocaleString()}`);
  console.log('');

  console.log('WITHOUT Endless Mode (What You Built):');
  console.log(`  User-visible tokens:   ${aggregateResults.nonCompoundedWithout.toLocaleString()}t (discovery + tool outputs, no accumulation)`);
  console.log(`  Processing tokens:     ${aggregateResults.totalContinuationTokensWithout.toLocaleString()}t (context re-reading accumulation)`);
  console.log(`  TOTAL PROCESSING:      ${aggregateResults.totalTokensWithout.toLocaleString()}t`);
  console.log('');

  console.log('WITH Endless Mode (Power Consumption Savings):');
  console.log(`  User-visible tokens:   ${aggregateResults.nonCompoundedWith.toLocaleString()}t (discovery + compressed, no accumulation)`);
  console.log(`  Processing tokens:     ${aggregateResults.totalContinuationTokensWith.toLocaleString()}t (compressed context re-reading)`);
  console.log(`  TOTAL PROCESSING:      ${aggregateResults.totalTokensWith.toLocaleString()}t`);
  console.log('');

  const userVisibleSaved = aggregateResults.nonCompoundedWithout - aggregateResults.nonCompoundedWith;
  const userVisiblePercent = (userVisibleSaved / aggregateResults.nonCompoundedWithout * 100).toFixed(1);

  console.log('💰 SAVINGS:');
  console.log(`  User-visible saved:    ${userVisibleSaved.toLocaleString()}t (${userVisiblePercent}% reduction in "spent" tokens)`);
  console.log(`  Processing saved:      ${tokensSaved.toLocaleString()}t (${percentSaved}% reduction in compute)`);
  console.log(`  Efficiency gain:       ${efficiencyGain}x`);
  console.log('');

  console.log('='.repeat(120) + '\n');
}

// Close database
db.close();
