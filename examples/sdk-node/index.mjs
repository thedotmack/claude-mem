#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Plain Node demonstration of `claude-mem/sdk`.
//
// Proves the headline requirement of the cmem-sdk plan:
//   capture -> generate -> search, in-process, with NO worker process running.
//
// Run with:
//   CLAUDE_MEM_SERVER_DATABASE_URL=postgres://user:pass@host:5432/db \
//   ANTHROPIC_API_KEY=sk-ant-... \
//     node index.mjs
//
// Prereqs:
//   - A reachable Postgres instance (the SDK bootstraps its own schema).
//   - `uvx` on PATH (the SDK starts a `uvx chroma-mcp` subprocess for
//     semantic search — Chroma is required, not optional).
//   - One generation provider API key (Anthropic by default; see the
//     CLAUDE_MEM_SERVER_PROVIDER / GEMINI_API_KEY / OPENROUTER_API_KEY
//     env vars to switch).

import { createCmemClient } from 'claude-mem/sdk';

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.length === 0) {
    console.error(
      `[sdk-node-example] ${name} is required. ` +
        `Set it in the environment and re-run.`
    );
    process.exit(1);
  }
  return value;
}

async function main() {
  requireEnv('CLAUDE_MEM_SERVER_DATABASE_URL');
  // Default provider is Claude; require an Anthropic key unless the
  // operator switched providers explicitly.
  const providerKind = (process.env.CLAUDE_MEM_SERVER_PROVIDER || 'claude').toLowerCase();
  if (providerKind === 'claude' || providerKind === 'anthropic') {
    requireEnv('ANTHROPIC_API_KEY');
  } else if (providerKind === 'gemini') {
    requireEnv('GEMINI_API_KEY');
  } else if (providerKind === 'openrouter') {
    requireEnv('OPENROUTER_API_KEY');
  }

  console.log('[sdk-node-example] creating client (no worker required)...');
  const client = await createCmemClient({
    databaseUrl: process.env.CLAUDE_MEM_SERVER_DATABASE_URL,
  });
  console.log(
    `[sdk-node-example] client ready (teamId=${client.teamId}, projectId=${client.projectId})`
  );

  try {
    console.log('[sdk-node-example] capturing + generating one observation...');
    const captured = await client.captureAndGenerate({
      sourceAdapter: 'sdk-node-example',
      eventType: 'demo',
      payload: {
        content:
          'Implementing OAuth flow with PKCE for native CLI clients. ' +
          'Key design points: device-code grant for headless installs, ' +
          'token refresh on exit, and short-lived access tokens cached in memory.',
      },
    });
    console.log(
      '[sdk-node-example] generated observations:',
      JSON.stringify(
        captured.result.observations.map((o) => ({
          id: o.id,
          kind: o.kind,
          content: o.content.slice(0, 120) + (o.content.length > 120 ? '…' : ''),
        })),
        null,
        2
      )
    );

    console.log('\n[sdk-node-example] searching for "OAuth"...');
    const searchResults = await client.search({ query: 'OAuth', limit: 5 });
    console.log(
      `[sdk-node-example] search returned ${searchResults.observations.length} result(s) ` +
        `(chroma=${searchResults.chroma}, degraded=${searchResults.degraded}):`
    );
    for (const o of searchResults.observations) {
      console.log(`  - ${o.id}: ${o.content.slice(0, 100)}…`);
    }

    console.log('\n[sdk-node-example] joining matching content into a context blob...');
    const context = await client.context({ query: 'OAuth', limit: 5 });
    console.log(
      `[sdk-node-example] context (${context.context.length} chars, degraded=${context.degraded}):`
    );
    console.log('---');
    console.log(context.context);
    console.log('---');
  } finally {
    await client.close();
    console.log('\n[sdk-node-example] client closed. No worker was running at any point.');
  }
}

main().catch((err) => {
  console.error('[sdk-node-example] failed:', err);
  process.exit(1);
});
