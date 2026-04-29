#!/usr/bin/env bun

import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";

const CONFIG = {
  corpusPath: process.env.RAGTIME_CORPUS_PATH ||
    path.join(process.cwd(), "datasets", "epstein-mode"),

  pluginPath: process.env.RAGTIME_PLUGIN_PATH ||
    path.join(process.cwd(), "plugin"),

  workerPort: parseInt(process.env.CLAUDE_MEM_WORKER_PORT || "37777", 10),

  transcriptMaxAgeHours: parseInt(process.env.RAGTIME_TRANSCRIPT_MAX_AGE || "24", 10),

  projectName: process.env.RAGTIME_PROJECT_NAME || "ragtime-investigation",

  fileLimit: parseInt(process.env.RAGTIME_FILE_LIMIT || "0", 10),

  sessionDelayMs: parseInt(process.env.RAGTIME_SESSION_DELAY || "2000", 10),
};

process.env.CLAUDE_MEM_MODE = "email-investigation";

function getFilesToProcess(): string[] {
  if (!fs.existsSync(CONFIG.corpusPath)) {
    console.error(`Corpus path does not exist: ${CONFIG.corpusPath}`);
    console.error("Set RAGTIME_CORPUS_PATH environment variable or create the directory");
    process.exit(1);
  }

  const files = fs
    .readdirSync(CONFIG.corpusPath)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || "0", 10);
      const numB = parseInt(b.match(/\d+/)?.[0] || "0", 10);
      return numA - numB;
    })
    .map((f) => path.join(CONFIG.corpusPath, f));

  if (files.length === 0) {
    console.error(`No .md files found in: ${CONFIG.corpusPath}`);
    process.exit(1);
  }

  if (CONFIG.fileLimit > 0) {
    return files.slice(0, CONFIG.fileLimit);
  }

  return files;
}

async function cleanupOldTranscripts(): Promise<void> {
  const transcriptsBase = path.join(homedir(), ".claude", "projects");

  if (!fs.existsSync(transcriptsBase)) {
    console.log("No transcripts directory found, skipping cleanup");
    return;
  }

  const maxAgeMs = CONFIG.transcriptMaxAgeHours * 60 * 60 * 1000;
  const now = Date.now();
  let cleaned = 0;

  try {
    const projectDirs = fs.readdirSync(transcriptsBase);

    for (const projectDir of projectDirs) {
      const projectPath = path.join(transcriptsBase, projectDir);
      const stat = fs.statSync(projectPath);

      if (!stat.isDirectory()) continue;

      const files = fs.readdirSync(projectPath);

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;

        const filePath = path.join(projectPath, file);
        const fileStat = fs.statSync(filePath);
        const fileAge = now - fileStat.mtimeMs;

        if (fileAge > maxAgeMs) {
          try {
            fs.unlinkSync(filePath);
            cleaned++;
          } catch (err) {
            console.warn(`Failed to delete old transcript: ${filePath}`);
          }
        }
      }

      const remaining = fs.readdirSync(projectPath);
      if (remaining.length === 0) {
        try {
          fs.rmdirSync(projectPath);
        } catch {
          // Ignore - may have race condition
        }
      }
    }

    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} old transcript(s)`);
    }
  } catch (err) {
    console.warn("Transcript cleanup error:", err);
  }
}

async function waitForQueueToEmpty(): Promise<void> {
  const maxWaitTimeMs = 5 * 60 * 1000; 
  const pollIntervalMs = 500;
  const startTime = Date.now();

  while (true) {
    try {
      const response = await fetch(
        `http://localhost:${CONFIG.workerPort}/api/processing-status`
      );

      if (!response.ok) {
        console.error(`Failed to get processing status: ${response.status}`);
        break;
      }

      const status = await response.json();

      if (status.queueDepth === 0 && !status.isProcessing) {
        break;
      }

      if (Date.now() - startTime > maxWaitTimeMs) {
        console.warn("Queue did not empty within timeout, continuing anyway");
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    } catch (error) {
      console.error("Error polling worker status:", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      break;
    }
  }
}

async function processFile(file: string, index: number, total: number): Promise<void> {
  const filename = path.basename(file);
  console.log(`\n[${ index + 1}/${total}] Processing: ${filename}`);

  try {
    for await (const message of query({
      prompt: `Read ${file} and analyze it in the context of the investigation. Look for entities, relationships, timeline events, and any anomalies. Cross-reference with what you know from the injected context above.`,
      options: {
        cwd: CONFIG.corpusPath,
        plugins: [{ type: "local", path: CONFIG.pluginPath }],
      },
    })) {
      if (message.type === "assistant") {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              const text = block.text.length > 500
                ? block.text.substring(0, 500) + "..."
                : block.text;
              console.log("Assistant:", text);
            }
          }
        } else if (typeof content === "string") {
          console.log("Assistant:", content);
        }
      }

      if (message.type === "result" && message.subtype === "success") {
        console.log(`Completed: ${filename}`);
      }
    }
  } catch (err) {
    console.error(`Error processing ${filename}:`, err);
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("RAGTIME Email Investigation Processor");
  console.log("=".repeat(60));
  console.log(`Mode: email-investigation`);
  console.log(`Corpus: ${CONFIG.corpusPath}`);
  console.log(`Plugin: ${CONFIG.pluginPath}`);
  console.log(`Worker: http://localhost:${CONFIG.workerPort}`);
  console.log(`Transcript cleanup: ${CONFIG.transcriptMaxAgeHours}h`);
  console.log("=".repeat(60));

  await cleanupOldTranscripts();

  const files = getFilesToProcess();
  console.log(`\nFound ${files.length} file(s) to process\n`);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    await processFile(file, i, files.length);

    console.log("Waiting for worker queue...");
    await waitForQueueToEmpty();

    if (i < files.length - 1 && CONFIG.sessionDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, CONFIG.sessionDelayMs));
    }

    if ((i + 1) % 10 === 0) {
      await cleanupOldTranscripts();
    }
  }

  await cleanupOldTranscripts();

  console.log("\n" + "=".repeat(60));
  console.log("Investigation complete");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
