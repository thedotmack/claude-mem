/**
 * Prototype ingestion script — ingests the first LoCoMo conversation
 * into claude-mem via the worker API.
 *
 * Usage: bun evals/locomo/scripts/ingest-one.ts
 *
 * Prerequisites: Worker must be running at localhost:37777.
 * Start with: bun plugin/scripts/worker-service.cjs start
 */

import { loadDataset, getSessionsForConversation } from "../src/dataset-loader.js";
import { WorkerClient } from "../src/ingestion/worker-client.js";
import {
  generateContentSessionId,
  generateProjectName,
  formatSessionAsToolExecution,
} from "../src/ingestion/adapter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKER_BASE_URL = "http://localhost:37777";
const HEALTH_ENDPOINT = `${WORKER_BASE_URL}/api/health`;
const POLL_INTERVAL_MS = 3_000;
const PROCESSING_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function checkWorkerHealth(): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_ENDPOINT);
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Check worker is running
  const workerHealthy = await checkWorkerHealth();
  if (!workerHealthy) {
    console.error(
      "Worker is not running at localhost:37777.\n" +
        "Start it with: bun plugin/scripts/worker-service.cjs start"
    );
    process.exit(1);
  }
  console.log("Worker is running.\n");

  // 2. Load dataset and get first conversation
  const dataset = loadDataset();
  const sample = dataset[0];
  const sessions = getSessionsForConversation(sample);
  const projectName = generateProjectName(sample.sample_id);

  console.log(`Ingesting conversation: ${sample.sample_id}`);
  console.log(`  Project: ${projectName}`);
  console.log(`  Sessions: ${sessions.length}\n`);

  const client = new WorkerClient(WORKER_BASE_URL);
  const overallStartTime = Date.now();

  // 3. Process each session
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const sessionStartTime = Date.now();
    const contentSessionId = generateContentSessionId(
      sample.sample_id,
      session.session_id
    );

    // 3a. Format session as tool execution
    const toolExec = formatSessionAsToolExecution(sample, session);

    // 3b. Init session
    await client.initSession(contentSessionId, projectName, toolExec.userPrompt);

    // 3c. Queue observation
    await client.queueObservation(
      contentSessionId,
      toolExec.toolName,
      toolExec.toolInput,
      toolExec.toolResponse
    );

    // 3d. Wait for processing
    await client.waitForProcessing(
      contentSessionId,
      PROCESSING_TIMEOUT_MS,
      POLL_INTERVAL_MS
    );

    // 3e. Complete session
    await client.completeSession(contentSessionId);

    const sessionElapsed = ((Date.now() - sessionStartTime) / 1000).toFixed(1);
    console.log(
      `Session ${i + 1}/${sessions.length} ingested — processing took ${sessionElapsed}s`
    );
  }

  // 4. Print summary
  const totalElapsed = ((Date.now() - overallStartTime) / 1000).toFixed(1);
  console.log(`\n=== Ingestion Complete ===`);
  console.log(`  Conversation: ${sample.sample_id}`);
  console.log(`  Sessions ingested: ${sessions.length}`);
  console.log(`  Total time: ${totalElapsed}s`);
}

main().catch((err) => {
  console.error("Ingestion failed:", err.message ?? err);
  process.exit(1);
});
