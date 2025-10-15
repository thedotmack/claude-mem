#!/usr/bin/env node

/**
 * Hook Helper Functions
 *
 * This module provides JavaScript wrappers around the TypeScript PromptOrchestrator
 * and HookTemplates system, making them accessible to the JavaScript hook scripts.
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Database } from 'bun:sqlite';
import os from 'os';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Creates a standardized hook response using the HookTemplates system
 * @param {string} hookType - Type of hook ('PreCompact' or 'SessionStart')
 * @param {boolean} success - Whether the operation was successful
 * @param {Object} options - Additional options
 * @returns {Object} Formatted hook response
 */
export function createHookResponse(hookType, success, options = {}) {
  if (hookType === 'PreCompact') {
    if (success) {
      return {
        continue: true,
        suppressOutput: true
      };
    } else {
      return {
        continue: false,
        stopReason: options.reason || 'Pre-compact operation failed',
        suppressOutput: true
      };
    }
  }
  
  if (hookType === 'SessionStart') {
    if (success && options.context) {
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: options.context
        }
      };
    } else {
      return {
        continue: true,
        suppressOutput: true
      };
    }
  }

  if (hookType === 'UserPromptSubmit' || hookType === 'PostToolUse') {
    return {
      continue: true,
      suppressOutput: true
    };
  }

  if (hookType === 'Stop') {
    return {
      continue: true,
      suppressOutput: true
    };
  }
  
  // Generic response for unknown hook types
  return {
    continue: success,
    suppressOutput: true,
    ...(options.reason && !success ? { stopReason: options.reason } : {})
  };
}

/**
 * Formats a session start context message using standardized templates
 * @param {Object} contextData - Context information
 * @returns {string} Formatted context message
 */
export function formatSessionStartContext(contextData) {
  const {
    projectName = 'unknown project',
    memoryCount = 0,
    lastSessionTime,
    recentComponents = [],
    recentDecisions = []
  } = contextData;
  
  const timeInfo = lastSessionTime ? ` (last worked: ${lastSessionTime})` : '';
  const contextParts = [];
  
  contextParts.push(`🧠 Loaded ${memoryCount} memories from previous sessions for ${projectName}${timeInfo}`);
  
  if (recentComponents.length > 0) {
    contextParts.push(`\n🎯 Recent components: ${recentComponents.slice(0, 3).join(', ')}`);
  }
  
  if (recentDecisions.length > 0) {
    contextParts.push(`\n🔄 Recent decisions: ${recentDecisions.slice(0, 2).join(', ')}`);
  }
  
  if (memoryCount > 0) {
    contextParts.push('\n💡 Use search_nodes("keywords") to find related work or open_nodes(["entity_name"]) to load specific components');
  }
  
  return contextParts.join('');
}

/**
 * Executes a CLI command and returns the result
 * @param {string} command - CLI command to execute
 * @param {Array} args - Command arguments
 * @param {Object} options - Spawn options
 * @returns {Promise<{stdout: string, stderr: string, success: boolean}>}
 */
export async function executeCliCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const { input, ...spawnOptions } = options;
    const process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...spawnOptions
    });
    
    let stdout = '';
    let stderr = '';
    
    if (process.stdout) {
      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }
    
    if (process.stderr) {
      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }
    
    if (input && process.stdin) {
      process.stdin.write(input);
      process.stdin.end();
    } else if (process.stdin) {
      process.stdin.end();
    }

    process.on('close', (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        success: code === 0
      });
    });
    
    process.on('error', (error) => {
      resolve({
        stdout: '',
        stderr: error.message,
        success: false
      });
    });
  });
}

/**
 * Parses context data from CLI output
 * @param {string} output - Raw CLI output
 * @returns {Object} Parsed context data
 */
export function parseContextData(output) {
  if (!output || !output.trim()) {
    return {
      memoryCount: 0,
      recentComponents: [],
      recentDecisions: []
    };
  }
  
  // Try to parse as JSON first (if CLI outputs structured data)
  try {
    const parsed = JSON.parse(output);
    return {
      memoryCount: parsed.memoryCount || 0,
      recentComponents: parsed.recentComponents || [],
      recentDecisions: parsed.recentDecisions || [],
      lastSessionTime: parsed.lastSessionTime
    };
  } catch (e) {
    // If not JSON, treat as plain text context
    const lines = output.split('\n').filter(line => line.trim());
    return {
      memoryCount: lines.length,
      recentComponents: [],
      recentDecisions: [],
      rawContext: output
    };
  }
}

/**
 * Validates hook payload structure
 * @param {Object} payload - Hook payload to validate
 * @param {string} expectedHookType - Expected hook event name
 * @returns {{valid: boolean, error?: string}} Validation result
 */
export function validateHookPayload(payload, expectedHookType) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Payload must be a valid object' };
  }
  
  if (!payload.session_id || typeof payload.session_id !== 'string') {
    return { valid: false, error: 'Missing or invalid session_id' };
  }
  
  if (!payload.transcript_path || typeof payload.transcript_path !== 'string') {
    return { valid: false, error: 'Missing or invalid transcript_path' };
  }
  
  if (expectedHookType && payload.hook_event_name !== expectedHookType) {
    return { valid: false, error: `Expected hook_event_name to be ${expectedHookType}` };
  }
  
  return { valid: true };
}

/**
 * Logs debug information if debug mode is enabled
 * @param {string} message - Debug message
 * @param {Object} data - Additional data to log
 */
export function debugLog(message, data = {}) {
  if (process.env.DEBUG === 'true' || process.env.CLAUDE_MEM_DEBUG === 'true') {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] HOOK DEBUG: ${message}`, data);
  }
}

// =============================================================================
// DATABASE HELPERS (inline SQL to avoid 'claude-mem' import issues)
// =============================================================================

/**
 * Get the claude-mem data directory path
 */
function getDataDirectory() {
  return join(os.homedir(), '.claude-mem');
}

/**
 * Get or create the database connection
 */
function getDatabase() {
  const dataDir = getDataDirectory();
  const dbPath = join(dataDir, 'claude-mem.db');

  // Ensure directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Apply optimized SQLite settings
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = memory');

  return db;
}

/**
 * Ensure the streaming_sessions table exists
 */
function ensureStreamingSessionsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS streaming_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claude_session_id TEXT UNIQUE NOT NULL,
      sdk_session_id TEXT,
      project TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      updated_at TEXT,
      updated_at_epoch INTEGER,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'failed'))
    )
  `);

  // Create indices if they don't exist
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_streaming_sessions_claude_id
    ON streaming_sessions(claude_session_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_streaming_sessions_sdk_id
    ON streaming_sessions(sdk_session_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_streaming_sessions_project_status
    ON streaming_sessions(project, status)
  `);
}

/**
 * Create a new streaming session record
 */
export function createStreamingSession(db, { claude_session_id, project, user_prompt, started_at }) {
  ensureStreamingSessionsTable(db);

  const timestamp = started_at || new Date().toISOString();
  const epoch = new Date(timestamp).getTime();

  const stmt = db.query(`
    INSERT INTO streaming_sessions (
      claude_session_id, project, user_prompt, started_at, started_at_epoch, status
    ) VALUES (?, ?, ?, ?, ?, 'active')
  `);

  const info = stmt.run(claude_session_id, project, user_prompt || null, timestamp, epoch);

  return db.query('SELECT * FROM streaming_sessions WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Update a streaming session by internal ID
 */
export function updateStreamingSession(db, id, updates) {
  const timestamp = new Date().toISOString();
  const epoch = Date.now();

  const parts = [];
  const values = [];

  if (updates.sdk_session_id !== undefined) {
    parts.push('sdk_session_id = ?');
    values.push(updates.sdk_session_id);
  }
  if (updates.title !== undefined) {
    parts.push('title = ?');
    values.push(updates.title);
  }
  if (updates.subtitle !== undefined) {
    parts.push('subtitle = ?');
    values.push(updates.subtitle);
  }
  if (updates.status !== undefined) {
    parts.push('status = ?');
    values.push(updates.status);
  }
  if (updates.completed_at !== undefined) {
    const completedTimestamp = typeof updates.completed_at === 'string'
      ? updates.completed_at
      : new Date(updates.completed_at).toISOString();
    const completedEpoch = new Date(completedTimestamp).getTime();
    parts.push('completed_at = ?', 'completed_at_epoch = ?');
    values.push(completedTimestamp, completedEpoch);
  }

  // Always update the updated_at timestamp
  parts.push('updated_at = ?', 'updated_at_epoch = ?');
  values.push(timestamp, epoch);

  values.push(id);

  const stmt = db.query(`
    UPDATE streaming_sessions
    SET ${parts.join(', ')}
    WHERE id = ?
  `);

  stmt.run(...values);

  return db.query('SELECT * FROM streaming_sessions WHERE id = ?').get(id);
}

/**
 * Get active streaming sessions for a project
 */
export function getActiveStreamingSessionsForProject(db, project) {
  ensureStreamingSessionsTable(db);

  const stmt = db.query(`
    SELECT * FROM streaming_sessions
    WHERE project = ? AND status = 'active'
    ORDER BY started_at_epoch DESC
  `);

  return stmt.all(project);
}

/**
 * Mark a session as completed
 */
export function markStreamingSessionCompleted(db, id) {
  const timestamp = new Date().toISOString();
  const epoch = Date.now();

  const stmt = db.query(`
    UPDATE streaming_sessions
    SET status = ?,
        completed_at = ?,
        completed_at_epoch = ?,
        updated_at = ?,
        updated_at_epoch = ?
    WHERE id = ?
  `);

  stmt.run('completed', timestamp, epoch, timestamp, epoch, id);

  return db.query('SELECT * FROM streaming_sessions WHERE id = ?').get(id);
}

/**
 * Initialize database with migrations and return connection
 */
export function initializeDatabase() {
  const db = getDatabase();
  ensureStreamingSessionsTable(db);
  ensureSessionLocksTable(db);
  return db;
}

// =============================================================================
// SESSION LOCKING (prevents concurrent SDK resume)
// =============================================================================

/**
 * Ensure the session_locks table exists
 */
function ensureSessionLocksTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_locks (
      sdk_session_id TEXT PRIMARY KEY,
      locked_by TEXT NOT NULL,
      locked_at TEXT NOT NULL,
      locked_at_epoch INTEGER NOT NULL
    )
  `);
}

/**
 * Attempt to acquire a lock on an SDK session
 * @returns {boolean} true if lock acquired, false if already locked
 */
export function acquireSessionLock(db, sdkSessionId, lockOwner) {
  ensureSessionLocksTable(db);

  try {
    const timestamp = new Date().toISOString();
    const epoch = Date.now();

    const stmt = db.query(`
      INSERT INTO session_locks (sdk_session_id, locked_by, locked_at, locked_at_epoch)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(sdkSessionId, lockOwner, timestamp, epoch);
    return true;
  } catch (error) {
    // UNIQUE constraint violation = already locked
    return false;
  }
}

/**
 * Release a lock on an SDK session
 */
export function releaseSessionLock(db, sdkSessionId) {
  ensureSessionLocksTable(db);

  const stmt = db.query(`
    DELETE FROM session_locks
    WHERE sdk_session_id = ?
  `);

  stmt.run(sdkSessionId);
}

/**
 * Clean up stale locks (older than 5 minutes)
 */
export function cleanupStaleLocks(db) {
  ensureSessionLocksTable(db);

  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);

  const stmt = db.query(`
    DELETE FROM session_locks
    WHERE locked_at_epoch < ?
  `);

  stmt.run(fiveMinutesAgo);
}
