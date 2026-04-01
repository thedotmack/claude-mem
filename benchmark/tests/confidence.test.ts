import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { loadPrompts } from '../src/prompt-loader.js';
import type { Prompt, AgentConfig, Arm } from '../src/types.js';
import type { AgentResult } from '../src/analysis/aggregator.js';

const SKIP_E2E = !process.env.RUN_E2E_TESTS;

const PROMPTS_DIR = join(import.meta.dir, '..', 'prompts');
const URL_SHORTENER_PROMPT_ID = '09-url-shortener';

describe('Confidence Test (2 agents)', () => {
  (SKIP_E2E ? test.skip : test)('full pipeline with URL Shortener prompt', async () => {
    // 1. Load the URL shortener prompt (09-url-shortener)
    const prompts = await loadPrompts(PROMPTS_DIR);
    const urlShortenerPrompt = prompts.find(
      (p) => p.frontmatter.id === URL_SHORTENER_PROMPT_ID,
    );
    expect(urlShortenerPrompt).toBeDefined();

    // 2. Build Docker images (vanilla + claude-mem)
    // TODO: Import ContainerManager and build both images
    // const containerManager = new ContainerManager();
    // await containerManager.buildImage(dockerfilePath, 'benchmark-agent', 'claude-mem');
    // await containerManager.buildImage(dockerfilePath, 'benchmark-agent', 'vanilla');

    // 3. Launch 2 containers (1 cmem, 1 vanilla)
    // TODO: Create AgentConfig for each arm and call containerManager.launchAgent()
    // const cmemConfig: AgentConfig = { agentId: 'cmem-09-1', arm: 'claude-mem', prompt: urlShortenerPrompt!, ... };
    // const vanillaConfig: AgentConfig = { agentId: 'vanilla-09-1', arm: 'vanilla', prompt: urlShortenerPrompt!, ... };
    // const cmemContainer = await containerManager.launchAgent(cmemConfig, 'benchmark-agent', resultsDir);
    // const vanillaContainer = await containerManager.launchAgent(vanillaConfig, 'benchmark-agent', resultsDir);

    // 4. Wait for both to complete (poll for DONE.md, max 4h)
    // TODO: Poll readAgentState() in a loop for each agent until isDone, isCrashed, or isKilled
    // const pollIntervalMs = 60_000; // 1 minute
    // const maxWaitMs = 4 * 60 * 60 * 1000; // 4 hours
    // while (!allDone && elapsed < maxWaitMs) { ... }

    // 5. Run smoke tests on both
    // TODO: Import runSmokeTests and execute against both containers
    // const cmemSmoke = await runSmokeTests('cmem-09-1', '09-url-shortener', urlShortenerPrompt!.frontmatter.smoke_tests, cmemContainer.containerId, resultsDir);
    // const vanillaSmoke = await runSmokeTests('vanilla-09-1', '09-url-shortener', urlShortenerPrompt!.frontmatter.smoke_tests, vanillaContainer.containerId, resultsDir);

    // 6. Run LLM judge on both
    // TODO: Import evaluateAgent and score both projects
    // const cmemJudge = await evaluateAgent('cmem-09-1', urlShortenerPrompt!, cmemProjectDir, cmemSmoke, rubricPath, judgeApiKey, model, resultsDir);
    // const vanillaJudge = await evaluateAgent('vanilla-09-1', urlShortenerPrompt!, vanillaProjectDir, vanillaSmoke, rubricPath, judgeApiKey, model, resultsDir);

    // 7. Aggregate results
    // TODO: Import aggregateAgent and produce AgentResult for each
    // const cmemResult = await aggregateAgent('cmem-09-1', resultsDir, urlShortenerPrompt!, model);
    // const vanillaResult = await aggregateAgent('vanilla-09-1', resultsDir, urlShortenerPrompt!, model);

    // 8. Validate both produce valid AgentResult JSON
    // TODO: Import validateAgainstSchema and check each result
    // const schemaPath = join(import.meta.dir, '..', 'schema', 'agent-result.schema.json');
    // expect(await validateAgainstSchema(cmemResult, schemaPath)).toBe(true);
    // expect(await validateAgainstSchema(vanillaResult, schemaPath)).toBe(true);

    // 9. Compare report shows both arms
    // TODO: Import generateSummary and verify both arms appear
    // const summary = generateSummary([cmemResult, vanillaResult]);
    // expect(summary.perArm).toHaveLength(2);
    // const armNames = summary.perArm.map(a => a.arm).sort();
    // expect(armNames).toEqual(['claude-mem', 'vanilla']);

    // Scaffold assertion — proves the test structure loads correctly
    expect(urlShortenerPrompt!.frontmatter.id).toBe(URL_SHORTENER_PROMPT_ID);
    expect(urlShortenerPrompt!.frontmatter.smoke_tests.length).toBeGreaterThan(0);
  }, 4 * 60 * 60 * 1000); // 4 hour timeout
});
