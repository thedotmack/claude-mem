/**
 * Direct database ingestion for LoCoMo evaluation data.
 *
 * Bypasses the claude-mem worker's AI compression pipeline and inserts
 * observations directly into SQLite + FTS index. This is necessary because
 * the worker's "Code Development" mode prompt instructs the AI to focus on
 * code deliverables, causing it to discard casual conversation transcripts
 * (obsCount=0 for 98%+ of sessions).
 *
 * Each LoCoMo session becomes one observation with:
 *   - Structured title, subtitle, and narrative
 *   - Full transcript in the text field (for FTS search)
 *   - Extracted speaker names and topics as concepts/facts
 *
 * Usage: bun evals/locomo/scripts/direct-ingest.ts [--force]
 *   --force: Delete existing locomo-eval observations and re-ingest
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import Database from "bun:sqlite";
import { randomUUID } from "crypto";
import { loadDataset, getSessionsForConversation } from "../src/dataset-loader.ts";
import {
  generateProjectName,
  formatSessionAsToolExecution,
} from "../src/ingestion/adapter.ts";
import type { LoCoMoSample, LoCoMoSession } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_PATH = join(homedir(), ".claude-mem", "claude-mem.db");
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROGRESS_FILE_PATH = resolve(MODULE_DIR, "../results/ingestion-progress.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ObservationRow {
  memory_session_id: string;
  project: string;
  text: string;
  type: string;
  title: string;
  subtitle: string;
  facts: string; // JSON array
  narrative: string;
  concepts: string; // JSON array
  files_read: string; // JSON array
  files_modified: string; // JSON array
  prompt_number: number;
  created_at: string;
  created_at_epoch: number;
  source_tool: string;
  source_input_summary: string;
}

// ---------------------------------------------------------------------------
// Observation builder
// ---------------------------------------------------------------------------

function buildObservation(
  sample: LoCoMoSample,
  session: LoCoMoSession,
  projectName: string,
  memorySessionId: string,
): ObservationRow {
  const { speaker_a, speaker_b } = sample.conversation;
  const toolExec = formatSessionAsToolExecution(sample, session);
  const transcript = toolExec.toolResponse;

  // Extract a brief topic summary from the first few turns
  const firstTurns = session.turns.slice(0, 4);
  const topicPreview = firstTurns
    .map((t) => t.text.slice(0, 80))
    .join(" ")
    .slice(0, 200);

  const title = `Conversation: ${speaker_a} and ${speaker_b} — Session ${session.session_id} (${session.date})`;
  const subtitle = `Dialog between ${speaker_a} and ${speaker_b} on ${session.date}. ${session.turns.length} turns.`;

  const facts: string[] = [
    `Session ${session.session_id} between ${speaker_a} and ${speaker_b} on ${session.date}`,
    `${session.turns.length} dialogue turns in this session`,
    `Transcript file: conversation-transcript/session-${session.session_id}.txt`,
  ];

  // Add topic hints from the conversation
  if (topicPreview.length > 20) {
    facts.push(`Topics discussed: ${topicPreview}...`);
  }

  const narrative = `Session ${session.session_id} is a conversation between ${speaker_a} and ${speaker_b} on ${session.date}. ${transcript.slice(0, 500)}`;

  const concepts = ["conversation-context", "personal-details", "how-it-works"];

  const now = new Date();

  return {
    memory_session_id: memorySessionId,
    project: projectName,
    text: transcript,
    type: "discovery",
    title,
    subtitle,
    facts: JSON.stringify(facts),
    narrative,
    concepts: JSON.stringify(concepts),
    files_read: JSON.stringify([`conversation-transcript/session-${session.session_id}.txt`]),
    files_modified: JSON.stringify([]),
    prompt_number: 1,
    created_at: now.toISOString(),
    created_at_epoch: Math.floor(now.getTime() / 1000),
    source_tool: "Read",
    source_input_summary: `Read conversation-transcript/session-${session.session_id}.txt`,
  };
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function insertObservation(db: Database, obs: ObservationRow): number {
  const stmt = db.prepare(`
    INSERT INTO observations (
      memory_session_id, project, text, type, title, subtitle,
      facts, narrative, concepts, files_read, files_modified,
      prompt_number, created_at, created_at_epoch, source_tool, source_input_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    obs.memory_session_id,
    obs.project,
    obs.text,
    obs.type,
    obs.title,
    obs.subtitle,
    obs.facts,
    obs.narrative,
    obs.concepts,
    obs.files_read,
    obs.files_modified,
    obs.prompt_number,
    obs.created_at,
    obs.created_at_epoch,
    obs.source_tool,
    obs.source_input_summary,
  );

  return Number(result.lastInsertRowid);
}

function insertFtsEntry(db: Database, observationId: number, obs: ObservationRow): void {
  db.prepare(`
    INSERT INTO observations_fts (rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    observationId,
    obs.title,
    obs.subtitle,
    obs.narrative,
    obs.text,
    obs.facts,
    obs.concepts,
  );
}

function ensureSdkSession(db: Database, contentSessionId: string, memorySessionId: string, project: string): void {
  const existing = db.prepare(
    "SELECT id FROM sdk_sessions WHERE content_session_id = ?"
  ).get(contentSessionId) as { id: number } | null;

  if (!existing) {
    const now = new Date();
    db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, user_prompt,
        started_at, started_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'completed')
    `).run(
      contentSessionId,
      memorySessionId,
      project,
      "Direct ingestion for LoCoMo eval",
      now.toISOString(),
      Math.floor(now.getTime() / 1000),
    );
  }
}

function deleteExistingLocomoObservations(db: Database): number {
  // Get IDs first for FTS cleanup
  const rows = db.prepare(
    "SELECT id FROM observations WHERE project LIKE 'locomo-eval-%'"
  ).all() as { id: number }[];

  if (rows.length === 0) return 0;

  // Delete FTS entries
  for (const row of rows) {
    db.prepare("DELETE FROM observations_fts WHERE rowid = ?").run(row.id);
  }

  // Delete observations
  db.prepare("DELETE FROM observations WHERE project LIKE 'locomo-eval-%'").run();

  // Delete sdk_sessions
  db.prepare("DELETE FROM sdk_sessions WHERE content_session_id LIKE 'locomo-%' AND project LIKE 'locomo-eval-%'").run();

  return rows.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const forceMode = process.argv.includes("--force");

  console.log("=== LoCoMo Direct Database Ingestion ===\n");

  // Open database
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  // Handle --force: delete existing observations
  if (forceMode) {
    const deleted = deleteExistingLocomoObservations(db);
    console.log(`Force mode: deleted ${deleted} existing locomo-eval observations\n`);
  }

  // Check existing observation counts per project
  const existingCounts = new Map<string, number>();
  const dataset = loadDataset();
  for (const sample of dataset) {
    const projectName = generateProjectName(sample.sample_id);
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM observations WHERE project = ?"
    ).get(projectName) as { cnt: number };
    existingCounts.set(sample.sample_id, row.cnt);
  }

  console.log(`Dataset: ${dataset.length} conversations\n`);

  const startTime = Date.now();
  let totalInserted = 0;
  let totalSkipped = 0;
  const progressEntries: Array<{
    sample_id: string;
    total_sessions: number;
    sessions_ingested: number;
    observations_queued: number;
    status: string;
  }> = [];

  for (let convIdx = 0; convIdx < dataset.length; convIdx++) {
    const sample = dataset[convIdx];
    const projectName = generateProjectName(sample.sample_id);
    const sessions = getSessionsForConversation(sample);
    const existingCount = existingCounts.get(sample.sample_id) ?? 0;

    if (existingCount >= sessions.length && !forceMode) {
      console.log(
        `[${convIdx + 1}/${dataset.length}] ${sample.sample_id} — SKIPPED (${existingCount} observations exist)`
      );
      totalSkipped += sessions.length;
      progressEntries.push({
        sample_id: sample.sample_id,
        total_sessions: sessions.length,
        sessions_ingested: sessions.length,
        observations_queued: sessions.length,
        status: "completed",
      });
      continue;
    }

    console.log(
      `[${convIdx + 1}/${dataset.length}] ${sample.sample_id} — ${sessions.length} sessions`
    );

    let insertedForConv = 0;

    // Use a transaction for each conversation
    const insertConversation = db.transaction(() => {
      for (const session of sessions) {
        const memorySessionId = randomUUID();
        const contentSessionId = `locomo-direct-${sample.sample_id}-s${session.session_id}`;

        // Build observation
        const obs = buildObservation(sample, session, projectName, memorySessionId);

        // Insert observation + FTS + session
        const obsId = insertObservation(db, obs);
        insertFtsEntry(db, obsId, obs);
        ensureSdkSession(db, contentSessionId, memorySessionId, projectName);

        insertedForConv++;
      }
    });

    insertConversation();
    totalInserted += insertedForConv;

    console.log(`  → Inserted ${insertedForConv} observations`);

    progressEntries.push({
      sample_id: sample.sample_id,
      total_sessions: sessions.length,
      sessions_ingested: sessions.length,
      observations_queued: sessions.length,
      status: "completed",
    });
  }

  db.close();

  // Save progress file
  const resultsDir = dirname(PROGRESS_FILE_PATH);
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }
  writeFileSync(PROGRESS_FILE_PATH, JSON.stringify(progressEntries, null, 2));

  const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
  console.log(`\n=== Ingestion Complete ===`);
  console.log(`  Inserted: ${totalInserted} observations`);
  console.log(`  Skipped: ${totalSkipped} (already existed)`);
  console.log(`  Time: ${elapsedSeconds}s`);
  console.log(`  Progress file: ${PROGRESS_FILE_PATH}`);
}

main().catch((err) => {
  console.error("Direct ingestion failed:", err.message ?? err);
  process.exit(1);
});
