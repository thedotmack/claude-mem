/**
 * System- and user-prompt construction for the solving agent.
 *
 * The system prompt encodes the requested workflow explicitly:
 *   1. /learn-codebase priming is injected up front (the codebase map).
 *   2. The agent is INSTRUCTED to use mem-search (mem_search → mem_timeline →
 *      mem_get_observations) before writing code, to recall prior solutions.
 *   3. Then it edits the working tree and submits.
 */
import type { SweBenchInstance } from './types.ts';

export interface PromptParts {
  system: string;
  user: string;
}

const WORKFLOW = `You are an autonomous software engineer resolving a real GitHub issue in a checked-out repository. You have a bash tool, a submit tool, and claude-mem memory-recall tools.

Follow this exact workflow:

1. RECALL FIRST (mem-search). Before reading much code, query claude-mem's cross-session memory to see how this repository or a similar issue was handled before:
   - mem_search(query=...) to get an index of relevant past observations.
   - mem_timeline(anchor=<id>) to see what surrounded a promising result.
   - mem_get_observations(ids=[...]) to pull full details for the few that look relevant.
   Treat any prior fix, decision, or gotcha you find as a strong prior — but verify it against the current code before relying on it. If memory returns nothing, proceed; do not fabricate recall.

2. LOCALIZE. Use the injected codebase priming and bash (grep/find/cat) to find the root cause. Reproduce the failure by running the relevant test(s) if practical.

3. FIX. Make the smallest correct edit to the NON-test source that resolves the issue. Do not edit tests — grading applies the official tests itself.

4. VERIFY & SUBMIT. Re-run the relevant tests. When the working tree fully resolves the issue, call submit. Your patch is whatever \`git diff\` shows, so leave the tree in exactly the state you want graded.

Rules:
- Prefer targeted edits over broad rewrites. Keep changes minimal and idiomatic to the surrounding code.
- Never run destructive commands (no rm -rf outside the repo, no network installs unless a test requires them).
- If you get stuck after several attempts, submit your best partial fix rather than looping forever.`;

/**
 * Build the system + first user message. `primingBlock` is the rendered
 * /learn-codebase map; pass an empty string to skip priming (it will still tell
 * the model priming was skipped so behavior is explicit).
 */
export function buildPrompt(instance: SweBenchInstance, primingBlock: string): PromptParts {
  const priming = primingBlock.trim()
    ? primingBlock
    : '# Codebase priming (/learn-codebase)\n\nPriming was skipped for this run. Use bash to explore the repository.';

  const system = [
    WORKFLOW,
    '',
    '---',
    '',
    `Repository: ${instance.repo}`,
    `Base commit: ${instance.base_commit}`,
    '',
    priming,
  ].join('\n');

  const user = [
    'Resolve the following issue. Begin by recalling relevant prior work with the mem_* tools.',
    '',
    '## Issue',
    '',
    instance.problem_statement,
    ...(typeof instance.hints_text === 'string' && instance.hints_text.trim()
      ? ['', '## Hints', '', instance.hints_text]
      : []),
  ].join('\n');

  return { system, user };
}
