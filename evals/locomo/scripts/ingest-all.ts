/**
 * Batch ingestion script — ingests all 10 LoCoMo conversations
 * into claude-mem via the worker API.
 *
 * Supports resume: checks each conversation's project for existing
 * observations and skips already-ingested conversations.
 *
 * Usage: bun evals/locomo/scripts/ingest-all.ts
 *
 * Prerequisites: Worker must be running at localhost:37777.
 * Start with: bun plugin/scripts/worker-service.cjs start
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadDataset, getSessionsForConversation } from "../src/dataset-loader.js";
import { WorkerClient } from "../src/ingestion/worker-client.js";
import {
  generateContentSessionId,
  generateProjectName,
  formatSessionAsToolExecution,
} from "../src/ingestion/adapter.js";
import type { IngestionProgress } from "../src/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKER_BASE_URL = "http://localhost:37777";
const HEALTH_ENDPOINT = `${WORKER_BASE_URL}/api/health`;
const POLL_INTERVAL_MS = 3_000;
const PROCESSING_TIMEOUT_MS = 180_000;
const MAX_SESSION_RETRIES = 2;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROGRESS_FILE_PATH = resolve(
  MODULE_DIR,
  "../results/ingestion-progress.json"
);

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
// Progress file
// ---------------------------------------------------------------------------

function loadProgressFile(): IngestionProgress[] {
  try {
    const raw = readFileSync(PROGRESS_FILE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveProgressFile(progressEntries: IngestionProgress[]): void {
  const resultsDir = dirname(PROGRESS_FILE_PATH);
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }
  writeFileSync(PROGRESS_FILE_PATH, JSON.stringify(progressEntries, null, 2));
}

// ---------------------------------------------------------------------------
// Resume check
// ---------------------------------------------------------------------------

async function conversationAlreadyIngested(
  client: WorkerClient,
  projectName: string
): Promise<boolean> {
  try {
    const searchResult = await client.search("*", projectName, 1);
    return searchResult.observations.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Elapsed time formatting
// ---------------------------------------------------------------------------

function formatElapsed(startMs: number): string {
  const elapsedSeconds = Math.floor((Date.now() - startMs) / 1000);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
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

  // 2. Load dataset
  const dataset = loadDataset();
  console.log(`Dataset loaded: ${dataset.length} conversations\n`);

  const client = new WorkerClient(WORKER_BASE_URL);
  const progressEntries = loadProgressFile();
  const overallStartTime = Date.now();

  let skippedCount = 0;
  let ingestedCount = 0;
  let failedCount = 0;

  // 3. Process each conversation
  for (let convIndex = 0; convIndex < dataset.length; convIndex++) {
    const sample = dataset[convIndex];
    const projectName = generateProjectName(sample.sample_id);
    const sessions = getSessionsForConversation(sample);

    // 3a. Resume check — skip if already ingested
    const alreadyIngested = await conversationAlreadyIngested(
      client,
      projectName
    );
    if (alreadyIngested) {
      console.log(
        `Conversation ${convIndex + 1}/${dataset.length} [${sample.sample_id}] — SKIPPED (already ingested)`
      );
      skippedCount++;
      continue;
    }

    console.log(
      `\nConversation ${convIndex + 1}/${dataset.length} [${sample.sample_id}] — ${sessions.length} sessions`
    );

    const progressEntry: IngestionProgress = {
      sample_id: sample.sample_id,
      total_sessions: sessions.length,
      sessions_ingested: 0,
      observations_queued: 0,
      status: "in_progress",
    };

    let sessionFailures = 0;

    // 3b. Process each session
    for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex++) {
      const session = sessions[sessionIndex];
      const contentSessionId = generateContentSessionId(
        sample.sample_id,
        session.session_id
      );
      const toolExec = formatSessionAsToolExecution(sample, session);

      let succeeded = false;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= MAX_SESSION_RETRIES; attempt++) {
        try {
          // Init session
          await client.initSession(
            contentSessionId,
            projectName,
            toolExec.userPrompt
          );

          // Queue observation
          await client.queueObservation(
            contentSessionId,
            toolExec.toolName,
            toolExec.toolInput,
            toolExec.toolResponse
          );

          // Wait for processing
          await client.waitForProcessing(
            contentSessionId,
            PROCESSING_TIMEOUT_MS,
            POLL_INTERVAL_MS
          );

          // Complete session
          await client.completeSession(contentSessionId);

          succeeded = true;
          break;
        } catch (error: unknown) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt < MAX_SESSION_RETRIES) {
            console.log(
              `  Session ${sessionIndex + 1}/${sessions.length} — retry ${attempt + 1}/${MAX_SESSION_RETRIES} after error: ${lastError.message}`
            );
          }
        }
      }

      if (succeeded) {
        progressEntry.sessions_ingested++;
        progressEntry.observations_queued++;
        console.log(
          `  Conversation ${convIndex + 1}/${dataset.length} [${sample.sample_id}] — Session ${sessionIndex + 1}/${sessions.length} — Elapsed: ${formatElapsed(overallStartTime)}`
        );
      } else {
        sessionFailures++;
        console.error(
          `  Session ${sessionIndex + 1}/${sessions.length} FAILED after ${MAX_SESSION_RETRIES + 1} attempts: ${lastError?.message}`
        );
      }
    }

    // 3c. Update progress entry
    if (sessionFailures === 0) {
      progressEntry.status = "completed";
      ingestedCount++;
    } else if (progressEntry.sessions_ingested > 0) {
      progressEntry.status = "completed";
      ingestedCount++;
      console.log(
        `  Conversation ${sample.sample_id}: ${sessionFailures} session(s) failed out of ${sessions.length}`
      );
    } else {
      progressEntry.status = "failed";
      failedCount++;
    }

    // 3d. Append to progress file
    const existingIndex = progressEntries.findIndex(
      (e) => e.sample_id === sample.sample_id
    );
    if (existingIndex >= 0) {
      progressEntries[existingIndex] = progressEntry;
    } else {
      progressEntries.push(progressEntry);
    }
    saveProgressFile(progressEntries);
  }

  // 4. Print summary
  const totalElapsed = formatElapsed(overallStartTime);
  console.log(`\n=== Batch Ingestion Complete ===`);
  console.log(`  Total conversations: ${dataset.length}`);
  console.log(`  Ingested: ${ingestedCount}`);
  console.log(`  Skipped (already ingested): ${skippedCount}`);
  console.log(`  Failed: ${failedCount}`);
  console.log(`  Total time: ${totalElapsed}`);
  console.log(`  Progress file: ${PROGRESS_FILE_PATH}`);
}

main().catch((err) => {
  console.error("Batch ingestion failed:", err.message ?? err);
  process.exit(1);
});
