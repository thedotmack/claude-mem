import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as path from "path";

const pathToFolder = "/Users/alexnewman/Scripts/claude-mem/datasets/epstein-mode/";
const pathToPlugin = "/Users/alexnewman/Scripts/claude-mem/plugin/";
const WORKER_PORT = 37777;

// Or read from a directory
const filesToProcess = fs
  .readdirSync(pathToFolder)
  .filter((f) => f.endsWith(".md"))
  .sort((a, b) => {
    // Extract numeric part from filename (e.g., "0001.md" -> 1)
    const numA = parseInt(a.match(/\d+/)?.[0] || "0", 10);
    const numB = parseInt(b.match(/\d+/)?.[0] || "0", 10);
    return numA - numB;
  })
  .map((f) => path.join(pathToFolder, f));

/**
 * Poll the worker's processing status endpoint until the queue is empty
 */
async function waitForQueueToEmpty(): Promise<void> {
  const maxWaitTimeMs = 5 * 60 * 1000; // 5 minutes maximum
  const pollIntervalMs = 500; // Poll every 500ms
  const startTime = Date.now();

  while (true) {
    try {
      const response = await fetch(`http://localhost:${WORKER_PORT}/api/processing-status`);
      if (!response.ok) {
        console.error(`Failed to get processing status: ${response.status}`);
        break;
      }

      const status = await response.json();
      console.log(`Queue status - Processing: ${status.isProcessing}, Queue depth: ${status.queueDepth}`);

      // Exit when queue is empty
      if (status.queueDepth === 0 && !status.isProcessing) {
        console.log("Queue is empty, continuing to next prompt");
        break;
      }

      // Check timeout
      if (Date.now() - startTime > maxWaitTimeMs) {
        console.warn("Warning: Queue did not empty within timeout, continuing anyway");
        break;
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    } catch (error) {
      console.error("Error polling worker status:", error);
      // On error, wait a bit and continue to avoid infinite loop
      await new Promise(resolve => setTimeout(resolve, 1000));
      break;
    }
  }
}

// var i = 0;

for (const file of filesToProcess) {
  // i++;
  // Limit for testing
  // if (i > 3) break;

  console.log(`\n=== Processing ${file} ===\n`);

  for await (const message of query({
    prompt: `Read ${file} and think about how it relates to the injected context above (if any).`,
    options: {
      cwd: pathToFolder,
      plugins: [{ type: "local", path: pathToPlugin }],
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      console.log("Plugins:", message.plugins);
      console.log("Commands:", message.slash_commands);
    }

    if (message.type === "assistant") {
      console.log("Assistant:", message.message.content);
    }
    console.log("Raw:",  JSON.stringify(message, null, 2));
  }

  // Wait for the worker queue to be empty before continuing to the next file
  console.log("\n=== Waiting for worker queue to empty ===\n");
  await waitForQueueToEmpty();
}
