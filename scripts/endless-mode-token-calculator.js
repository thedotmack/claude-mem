#!/usr/bin/env node

/**
 * Endless Mode Token Economics Calculator
 *
 * Simulates the recursive/cumulative token savings from Endless Mode by
 * "playing the tape through" with real observation data from SQLite.
 *
 * Key Insight:
 * - Discovery tokens are ALWAYS spent (creating observations)
 * - But Endless Mode feeds compressed observations as context instead of full tool outputs
 * - Savings compound recursively - each tool benefits from ALL previous compressions
 */

const observationsData = [{"id":10136,"type":"decision","title":"Token Accounting Function for Recursive Continuation Pattern","discovery_tokens":4037,"created_at_epoch":1763360747429,"compressed_size":1613},
{"id":10135,"type":"discovery","title":"Sequential Thinking Analysis of Token Economics Calculator","discovery_tokens":1439,"created_at_epoch":1763360651617,"compressed_size":1812},
{"id":10134,"type":"discovery","title":"Recent Context Query Execution","discovery_tokens":1273,"created_at_epoch":1763360646273,"compressed_size":1228},
{"id":10133,"type":"discovery","title":"Token Data Query Execution and Historical Context","discovery_tokens":11878,"created_at_epoch":1763360642485,"compressed_size":1924},
{"id":10132,"type":"discovery","title":"Token Data Query and Script Validation Request","discovery_tokens":4167,"created_at_epoch":1763360628269,"compressed_size":903},
{"id":10131,"type":"discovery","title":"Endless Mode Token Economics Analysis Output: Complete Infrastructure Impact","discovery_tokens":2458,"created_at_epoch":1763360553238,"compressed_size":2166},
{"id":10130,"type":"change","title":"Integration of Actual Compute Savings Analysis into Main Execution Flow","discovery_tokens":11031,"created_at_epoch":1763360545347,"compressed_size":1032},
{"id":10129,"type":"discovery","title":"Prompt Caching Economics: User Cost vs. Anthropic Compute Cost Divergence","discovery_tokens":20059,"created_at_epoch":1763360540854,"compressed_size":1802},
{"id":10128,"type":"discovery","title":"Token Caching Cost Analysis Across AI Model Providers","discovery_tokens":3506,"created_at_epoch":1763360478133,"compressed_size":1245},
{"id":10127,"type":"discovery","title":"Endless Mode Token Economics Calculator Successfully Integrated Prompt Caching Cost Model","discovery_tokens":3481,"created_at_epoch":1763360384055,"compressed_size":2444},
{"id":10126,"type":"bugfix","title":"Fix Return Statement Variable Names in playTheTapeThrough Function","discovery_tokens":8326,"created_at_epoch":1763360374566,"compressed_size":1250},
{"id":10125,"type":"change","title":"Redesign Timeline Display to Show Fresh/Cached Token Breakdown and Real Dollar Costs","discovery_tokens":12999,"created_at_epoch":1763360368843,"compressed_size":2004},
{"id":10124,"type":"change","title":"Replace Estimated Cost Model with Actual Caching-Based Costs in Anthropic Scale Analysis","discovery_tokens":12867,"created_at_epoch":1763360361147,"compressed_size":2064},
{"id":10123,"type":"change","title":"Pivot Session Length Comparison Table from Token to Cost Metrics","discovery_tokens":9746,"created_at_epoch":1763360352992,"compressed_size":1652},
{"id":10122,"type":"change","title":"Add Dual Reporting: Token Count vs Actual Cost in Comparison Output","discovery_tokens":9602,"created_at_epoch":1763360346495,"compressed_size":1640},
{"id":10121,"type":"change","title":"Apply Prompt Caching Cost Model to Endless Mode Calculation Function","discovery_tokens":9963,"created_at_epoch":1763360339238,"compressed_size":2003},
{"id":10120,"type":"change","title":"Integrate Prompt Caching Cost Calculations into Without-Endless-Mode Function","discovery_tokens":8652,"created_at_epoch":1763360332046,"compressed_size":1701},
{"id":10119,"type":"change","title":"Display Prompt Caching Pricing in Initial Calculator Output","discovery_tokens":6669,"created_at_epoch":1763360325882,"compressed_size":1188},
{"id":10118,"type":"change","title":"Add Prompt Caching Pricing Model to Token Economics Calculator","discovery_tokens":10433,"created_at_epoch":1763360320552,"compressed_size":1264},
{"id":10117,"type":"discovery","title":"Claude API Prompt Caching Cost Optimization Factor","discovery_tokens":3439,"created_at_epoch":1763360210175,"compressed_size":1142},
{"id":10116,"type":"discovery","title":"Endless Mode Token Economics Verified at Scale","discovery_tokens":2855,"created_at_epoch":1763360144039,"compressed_size":2184},
{"id":10115,"type":"feature","title":"Token Economics Calculator for Endless Mode Sessions","discovery_tokens":13468,"created_at_epoch":1763360134068,"compressed_size":1858},
{"id":10114,"type":"decision","title":"Token Accounting for Recursive Session Continuations","discovery_tokens":3550,"created_at_epoch":1763360052317,"compressed_size":1478},
{"id":10113,"type":"discovery","title":"Performance and Token Optimization Impact Analysis for Endless Mode","discovery_tokens":3464,"created_at_epoch":1763359862175,"compressed_size":1259},
{"id":10112,"type":"change","title":"Endless Mode Blocking Hooks & Transcript Transformation Plan Document Created","discovery_tokens":17312,"created_at_epoch":1763359465307,"compressed_size":2181},
{"id":10111,"type":"change","title":"Plan Document Creation for Morning Implementation","discovery_tokens":3652,"created_at_epoch":1763359347166,"compressed_size":843},
{"id":10110,"type":"decision","title":"Blocking vs Non-Blocking Behavior by Mode","discovery_tokens":3652,"created_at_epoch":1763359347165,"compressed_size":797},
{"id":10109,"type":"decision","title":"Tool Use and Observation Processing Architecture: Non-Blocking vs Blocking","discovery_tokens":3472,"created_at_epoch":1763359247045,"compressed_size":1349},
{"id":10108,"type":"feature","title":"SessionManager.getMessageIterator implements event-driven async generator with graceful abort handling","discovery_tokens":2417,"created_at_epoch":1763359189299,"compressed_size":2016},
{"id":10107,"type":"feature","title":"SessionManager implements event-driven session lifecycle with auto-initialization and zero-latency queue notifications","discovery_tokens":4734,"created_at_epoch":1763359165608,"compressed_size":2781},
{"id":10106,"type":"discovery","title":"Two distinct uses of transcript data: live data flow vs session initialization","discovery_tokens":2933,"created_at_epoch":1763359156448,"compressed_size":2015},
{"id":10105,"type":"discovery","title":"Transcript initialization pattern identified for compressed context on session resume","discovery_tokens":2933,"created_at_epoch":1763359156447,"compressed_size":2536},
{"id":10104,"type":"feature","title":"SDKAgent implements event-driven message generator with continuation prompt logic and Endless Mode integration","discovery_tokens":6148,"created_at_epoch":1763359140399,"compressed_size":3241},
{"id":10103,"type":"discovery","title":"Endless Mode architecture documented with phased implementation plan and context economics","discovery_tokens":5296,"created_at_epoch":1763359127954,"compressed_size":3145},
{"id":10102,"type":"feature","title":"Save hook enhanced to extract and forward tool_use_id for Endless Mode linking","discovery_tokens":3294,"created_at_epoch":1763359115848,"compressed_size":2125},
{"id":10101,"type":"feature","title":"TransformLayer implements Endless Mode context compression via observation substitution","discovery_tokens":4637,"created_at_epoch":1763359108317,"compressed_size":2629},
{"id":10100,"type":"feature","title":"EndlessModeConfig implemented for loading Endless Mode settings from files and environment","discovery_tokens":2313,"created_at_epoch":1763359099972,"compressed_size":2125},
{"id":10098,"type":"change","title":"User prompts wrapped with semantic XML structure in buildInitPrompt and buildContinuationPrompt","discovery_tokens":7806,"created_at_epoch":1763359091460,"compressed_size":1585},
{"id":10099,"type":"discovery","title":"Session persistence mechanism relies on SDK internal state without context reload","discovery_tokens":7806,"created_at_epoch":1763359091460,"compressed_size":1883},
{"id":10097,"type":"change","title":"Worker service session init now extracts userPrompt and promptNumber from request body","discovery_tokens":7806,"created_at_epoch":1763359091459,"compressed_size":1148},
{"id":10096,"type":"feature","title":"SessionManager enhanced to accept dynamic userPrompt updates during multi-turn conversations","discovery_tokens":7806,"created_at_epoch":1763359091457,"compressed_size":1528},
{"id":10095,"type":"discovery","title":"Five lifecycle hooks integrate claude-mem at critical session boundaries","discovery_tokens":6625,"created_at_epoch":1763359074808,"compressed_size":1570},
{"id":10094,"type":"discovery","title":"PostToolUse hook is real-time observation creation point, not delayed processing","discovery_tokens":6625,"created_at_epoch":1763359074807,"compressed_size":2371},
{"id":10093,"type":"discovery","title":"PostToolUse hook timing and compression integration options explored","discovery_tokens":1696,"created_at_epoch":1763359062088,"compressed_size":1605},
{"id":10092,"type":"discovery","title":"Transcript transformation strategy for endless mode identified","discovery_tokens":6112,"created_at_epoch":1763359057563,"compressed_size":1968},
{"id":10091,"type":"decision","title":"Finalized Transcript Compression Implementation Strategy","discovery_tokens":1419,"created_at_epoch":1763358943803,"compressed_size":1556},
{"id":10090,"type":"discovery","title":"UserPromptSubmit Hook as Compression Integration Point","discovery_tokens":1546,"created_at_epoch":1763358931936,"compressed_size":1621},
{"id":10089,"type":"decision","title":"Hypothesis 5 Selected: UserPromptSubmit Hook for Transcript Compression","discovery_tokens":1465,"created_at_epoch":1763358920209,"compressed_size":1918}];

// Estimate original tool output size from discovery tokens
// Heuristic: discovery_tokens roughly correlates with original content size
// Assumption: If it took 10k tokens to analyze, original was probably 15-30k tokens
function estimateOriginalToolOutputSize(discoveryTokens) {
  // Conservative multiplier: 2x (original content was 2x the discovery cost)
  // This accounts for: reading the tool output + analyzing it + generating observation
  return discoveryTokens * 2;
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
      title: obs.title.substring(0, 60),
      originalSize: originalToolSize,
      discoveryCost,
      contextSize: cumulativeContextTokens,
      continuationCost,
      totalCostSoFar: totalDiscoveryTokens + totalContinuationTokens
    });
  });

  return {
    totalDiscoveryTokens,
    totalContinuationTokens,
    totalTokens: totalDiscoveryTokens + totalContinuationTokens,
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
      title: obs.title.substring(0, 60),
      originalSize: originalToolSize,
      compressedSize,
      compressionRatio: `${compressionRatio}%`,
      discoveryCost,
      contextSize: cumulativeContextTokens,
      continuationCost,
      totalCostSoFar: totalDiscoveryTokens + totalContinuationTokens
    });
  });

  return {
    totalDiscoveryTokens,
    totalContinuationTokens,
    totalTokens: totalDiscoveryTokens + totalContinuationTokens,
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

// Run the calculation
playTheTapeThrough(observationsData);
