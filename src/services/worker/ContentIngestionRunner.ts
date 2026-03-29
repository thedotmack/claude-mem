/**
 * ContentIngestionRunner: Engine-side orchestrator for Storyline file-by-file content ingestion
 *
 * Reads files directly with fs, then feeds content to an observer SDK agent session
 * for each file. Tracks progress in SQLite via StorylineRepository.
 *
 * This is a peer to EndlessRunner, not a subclass. It shares utilities
 * (agent-utils, EnvManager, paths) but owns its own lifecycle and prompt strategy.
 */

import { readFileSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { findClaudeExecutable, getModelId } from './agent-utils.js';
import { buildIsolatedEnv } from '../../shared/EnvManager.js';
import { OBSERVER_SESSIONS_DIR, ensureDir } from '../../shared/paths.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { buildInitPrompt } from '../../sdk/prompts.js';
import { StorylineRepository } from '../sqlite/StorylineRepository.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import type { ModeConfig } from '../domain/types.js';

// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface StorylineRunStatus {
  run: {
    run_id: string;
    status: string;
    goal: string;
    total_files: number;
    files_processed: number;
    observations_generated: number;
    current_file: string | null;
    started_at: number;
    completed_at: number | null;
    error_message: string | null;
  };
  files: Array<{
    file_path: string;
    status: string;
    observations_count: number;
    error_message: string | null;
  }>;
}

export interface StorylineFileManifestEntry {
  path: string;
  content_hash: string;
}

export class ContentIngestionRunner {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private project: string;
  private goal: string;
  private modeConfig: ModeConfig;
  private files: StorylineFileManifestEntry[];
  private inboxPath: string;

  private runId: string | null = null;
  private currentAbortController: AbortController | null = null;
  private currentFile: string | null = null;
  private storylineRepo: StorylineRepository | null = null;

  constructor(
    dbManager: DatabaseManager,
    sessionManager: SessionManager,
    project: string,
    goal: string,
    modeConfig: ModeConfig,
    files: StorylineFileManifestEntry[],
    inboxPath: string
  ) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
    this.project = project;
    this.goal = goal;
    this.modeConfig = modeConfig;
    this.files = files;
    this.inboxPath = inboxPath;
  }

  /**
   * Get the StorylineRepository (lazy init from SessionStore's db connection)
   */
  private getRepo(): StorylineRepository {
    if (!this.storylineRepo) {
      const sessionStore = this.dbManager.getSessionStore();
      this.storylineRepo = new StorylineRepository(sessionStore.db);
    }
    return this.storylineRepo;
  }

  /**
   * Create a run record in SQLite, insert file manifest, return run_id
   */
  async startRun(): Promise<string> {
    const runId = `storyline-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.runId = runId;

    const repo = this.getRepo();

    repo.createStorylineRun({
      run_id: runId,
      project: this.project,
      goal: this.goal,
      mode_config: JSON.stringify(this.modeConfig),
      total_files: this.files.length,
      started_at: Date.now(),
    });

    repo.createStorylineFiles(runId, this.files);

    logger.info('STORYLINE', 'Run started', {
      run_id: runId,
      project: this.project,
      total_files: this.files.length,
      goal: this.goal.substring(0, 100),
    });

    return runId;
  }

  /**
   * Sequential file-by-file processing loop
   *
   * For each file:
   * 1. Check dedup (same content_hash already processed for this project)
   * 2. Read file content with fs.readFileSync
   * 3. Build observer prompt with file content embedded
   * 4. Spawn SDK agent session via query()
   * 5. Count observations from observation-confirmed events
   * 6. Update file and run progress in SQLite
   */
  async processFiles(): Promise<void> {
    if (!this.runId) {
      throw new Error('Must call startRun() before processFiles()');
    }

    const repo = this.getRepo();
    const processedHashes = repo.getProcessedHashes(this.project);

    const claudePath = findClaudeExecutable();
    const modelId = getModelId();
    const isolatedEnv = sanitizeEnv(buildIsolatedEnv());
    ensureDir(OBSERVER_SESSIONS_DIR);

    let filesProcessed = 0;
    let totalObservations = 0;

    for (const file of this.files) {
      // Check for cancellation before each file
      if (this.currentAbortController?.signal.aborted) {
        logger.info('STORYLINE', 'Run cancelled, stopping file processing', {
          run_id: this.runId,
          files_processed: filesProcessed,
        });
        break;
      }

      this.currentFile = file.path;

      // Step 1: Dedup check
      if (processedHashes.has(file.content_hash)) {
        logger.info('STORYLINE', 'Skipping already-processed file', {
          run_id: this.runId,
          file: file.path,
          content_hash: file.content_hash,
        });
        repo.updateFileStatus(this.runId, file.path, 'skipped');
        filesProcessed++;
        repo.updateRunProgress(this.runId, filesProcessed, totalObservations);
        continue;
      }

      // Step 2: Read file content
      repo.updateFileStatus(this.runId, file.path, 'reading');

      let fileContent: string;
      try {
        fileContent = readFileSync(file.path, 'utf-8');
      } catch (error) {
        const errorMessage = (error as Error).message;
        logger.warn('STORYLINE', 'Failed to read file, marking as skipped', {
          run_id: this.runId,
          file: file.path,
          error: errorMessage,
        });
        repo.updateFileStatus(this.runId, file.path, 'skipped', 0, errorMessage);
        filesProcessed++;
        repo.updateRunProgress(this.runId, filesProcessed, totalObservations);
        continue;
      }

      // Step 3: Build observer prompt with file content
      const filePrompt = this.buildFileObserverPrompt(file.path, fileContent);

      // Step 4: Spawn SDK agent session
      const abortController = new AbortController();
      this.currentAbortController = abortController;

      let fileObservations = 0;

      // Listen for observation-confirmed events, filtered to this session
      const pendingStore = this.sessionManager.getPendingMessageStore();
      const observationListener = () => {
        fileObservations++;
      };
      pendingStore.getEvents().on('observation-confirmed', observationListener);

      try {
        logger.info('STORYLINE', 'Processing file', {
          run_id: this.runId,
          file: file.path,
          file_size: fileContent.length,
        });

        const queryResult = query({
          prompt: filePrompt,
          options: {
            model: modelId,
            cwd: OBSERVER_SESSIONS_DIR,
            abortController,
            pathToClaudeCodeExecutable: claudePath,
            env: isolatedEnv,
          },
        });

        // Step 5: Iterate SDK messages, count observations
        for await (const message of queryResult) {
          if (message.type === 'result') {
            break;
          }
        }

        // Step 6: Mark file completed
        repo.updateFileStatus(this.runId, file.path, 'completed', fileObservations);
        totalObservations += fileObservations;
        filesProcessed++;
        repo.updateRunProgress(this.runId, filesProcessed, totalObservations);

        logger.info('STORYLINE', 'File processed', {
          run_id: this.runId,
          file: file.path,
          observations: fileObservations,
          progress: `${filesProcessed}/${this.files.length}`,
        });
      } catch (error) {
        const errorMessage = (error as Error).message;

        // Check if this was a cancellation
        if (abortController.signal.aborted) {
          logger.info('STORYLINE', 'File processing aborted', {
            run_id: this.runId,
            file: file.path,
          });
          repo.updateFileStatus(this.runId, file.path, 'failed', fileObservations, 'Cancelled');
          break;
        }

        // Failed files don't stop the run
        logger.error('STORYLINE', 'File processing failed', {
          run_id: this.runId,
          file: file.path,
          error: errorMessage,
        });
        repo.updateFileStatus(this.runId, file.path, 'failed', fileObservations, errorMessage);
        filesProcessed++;
        repo.updateRunProgress(this.runId, filesProcessed, totalObservations);
      } finally {
        pendingStore.getEvents().removeListener('observation-confirmed', observationListener);
      }
    }

    this.currentFile = null;

    // Determine final run status
    const wasCancelled = this.currentAbortController?.signal.aborted;
    if (wasCancelled) {
      repo.updateRunStatus(this.runId, 'cancelled', Date.now());
    } else {
      repo.updateRunStatus(this.runId, 'completed', Date.now());
    }

    logger.info('STORYLINE', 'Run finished', {
      run_id: this.runId,
      status: wasCancelled ? 'cancelled' : 'completed',
      files_processed: filesProcessed,
      total_observations: totalObservations,
    });
  }

  /**
   * Query SQLite for current run + file statuses
   */
  async getStatus(): Promise<StorylineRunStatus> {
    if (!this.runId) {
      throw new Error('Run not started');
    }

    const repo = this.getRepo();
    const result = repo.getStorylineRunStatus(this.runId);

    if (!result) {
      throw new Error(`Run ${this.runId} not found in database`);
    }

    return {
      run: {
        run_id: result.run.run_id,
        status: result.run.status,
        goal: result.run.goal,
        total_files: result.run.total_files,
        files_processed: result.run.files_processed,
        observations_generated: result.run.observations_generated,
        current_file: this.currentFile,
        started_at: result.run.started_at,
        completed_at: result.run.completed_at,
        error_message: result.run.error_message,
      },
      files: result.files.map(f => ({
        file_path: f.file_path,
        status: f.status,
        observations_count: f.observations_count,
        error_message: f.error_message,
      })),
    };
  }

  /**
   * Cancel the active ingestion run
   */
  async cancel(): Promise<void> {
    if (!this.runId) {
      throw new Error('Run not started');
    }

    logger.info('STORYLINE', 'Cancelling run', { run_id: this.runId });

    // Abort the current SDK session if one is active
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }

    // The processFiles loop will detect the abort and update status to 'cancelled'
  }

  /**
   * Build the observer prompt for a specific file's content.
   *
   * Uses buildInitPrompt from sdk/prompts.ts with the Storyline mode config,
   * then appends the file content for the observer to analyze.
   */
  private buildFileObserverPrompt(filePath: string, fileContent: string): string {
    // Use a synthetic session ID for the observer prompt
    const sessionId = `storyline-${this.runId}-${Date.now()}`;

    // Build the user prompt that describes what to analyze
    const userPrompt = [
      `Analyze the following file as part of a content ingestion task.`,
      `Goal: ${this.goal}`,
      `File: ${filePath}`,
      ``,
      `Generate observations about the content based on the goal. Focus on extracting`,
      `structured knowledge that will be useful for future queries.`,
    ].join('\n');

    // Build the init prompt with the mode config
    const initPrompt = buildInitPrompt(this.project, sessionId, userPrompt, this.modeConfig);

    // Append the actual file content as an observation source
    return [
      initPrompt,
      '',
      '<file_content>',
      `<file_path>${filePath}</file_path>`,
      fileContent,
      '</file_content>',
      '',
      'Analyze the file content above and generate observations based on the stated goal.',
      'Use the observation XML format specified in your instructions.',
    ].join('\n');
  }
}
