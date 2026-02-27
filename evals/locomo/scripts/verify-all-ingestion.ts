/**
 * Ingestion verification script — checks that all 10 LoCoMo conversations
 * were fully ingested into claude-mem by searching for observations under
 * each conversation's project name.
 *
 * Prints a completeness report table comparing expected session counts
 * against actual observation counts in claude-mem.
 *
 * Usage: bun evals/locomo/scripts/verify-all-ingestion.ts
 *
 * Prerequisites: Worker must be running at localhost:37777.
 */

import { loadDataset, getSessionsForConversation } from "../src/dataset-loader.js";
import { WorkerClient } from "../src/ingestion/worker-client.js";
import { generateProjectName } from "../src/ingestion/adapter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKER_BASE_URL = "http://localhost:37777";
const HEALTH_ENDPOINT = `${WORKER_BASE_URL}/api/health`;

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
// Verification result
// ---------------------------------------------------------------------------

interface VerificationRow {
  sampleId: string;
  expectedSessions: number;
  observationsFound: number;
  status: "complete" | "partial" | "missing";
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

  // 2. Load dataset
  const dataset = loadDataset();
  const client = new WorkerClient(WORKER_BASE_URL);

  // 3. Verify each conversation
  const rows: VerificationRow[] = [];

  for (const sample of dataset) {
    const projectName = generateProjectName(sample.sample_id);
    const sessions = getSessionsForConversation(sample);
    const expectedSessions = sessions.length;

    let observationsFound = 0;
    try {
      const result = await client.listObservationsByProject(projectName);
      observationsFound = result.total;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Error listing observations for ${projectName}: ${message}`);
    }

    let status: VerificationRow["status"];
    if (observationsFound >= expectedSessions) {
      status = "complete";
    } else if (observationsFound > 0) {
      status = "partial";
    } else {
      status = "missing";
    }

    rows.push({ sampleId: sample.sample_id, expectedSessions, observationsFound, status });
  }

  // 4. Print completeness report table
  console.log("\n=== Ingestion Verification Report ===\n");

  const sampleIdWidth = Math.max(
    "sample_id".length,
    ...rows.map((r) => r.sampleId.length)
  );

  const header = [
    "sample_id".padEnd(sampleIdWidth),
    "sessions",
    "observations",
    "status",
  ].join(" | ");

  const separator = [
    "-".repeat(sampleIdWidth),
    "-".repeat("sessions".length),
    "-".repeat("observations".length),
    "-".repeat("--------".length),
  ].join("-+-");

  console.log(header);
  console.log(separator);

  for (const row of rows) {
    const line = [
      row.sampleId.padEnd(sampleIdWidth),
      String(row.expectedSessions).padStart("sessions".length),
      String(row.observationsFound).padStart("observations".length),
      row.status,
    ].join(" | ");
    console.log(line);
  }

  // 5. Flag incomplete conversations
  const incomplete = rows.filter((r) => r.status !== "complete");
  if (incomplete.length > 0) {
    console.log(`\nWARNING: ${incomplete.length} conversation(s) have incomplete ingestion:`);
    for (const row of incomplete) {
      const deficit = row.expectedSessions - row.observationsFound;
      console.log(
        `  ${row.sampleId}: ${row.observationsFound}/${row.expectedSessions} observations (${deficit} missing)`
      );
    }
  } else {
    console.log("\nAll 10 conversations are fully ingested.");
  }

  // 6. Print summary
  const totalExpected = rows.reduce((sum, r) => sum + r.expectedSessions, 0);
  const totalFound = rows.reduce((sum, r) => sum + r.observationsFound, 0);
  console.log(
    `\nTotal: ${totalFound}/${totalExpected} observations across ${rows.length} conversations`
  );

  // Exit with non-zero if any conversation is incomplete
  if (incomplete.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Verification failed:", err.message ?? err);
  process.exit(1);
});
