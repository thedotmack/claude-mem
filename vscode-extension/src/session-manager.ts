/**
 * Session Manager for VSCode Extension
 * Manages mapping between Copilot conversation IDs and claude-mem session IDs
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SessionData {
  sessionDbId: number;
  conversationId: string;
  project: string;
  promptNumber: number;
  startTime: number;
}

/**
 * Manages sessions stored in SQLite (direct DB access for session management only)
 */
export class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  private dbPath: string;

  constructor() {
    this.dbPath = path.join(os.homedir(), '.claude-mem', 'claude-mem.db');
  }

  /**
   * Get database connection (uses better-sqlite3)
   * Note: We need to dynamically import better-sqlite3 at runtime
   */
  private async getDb() {
    // Check if database exists
    if (!fs.existsSync(this.dbPath)) {
      throw new Error('Claude-mem database not found. Please ensure the worker service is running.');
    }

    // Dynamic import of better-sqlite3 (will be bundled with extension)
    const Database = require('better-sqlite3');
    return new Database(this.dbPath);
  }

  /**
   * Create or get existing session
   */
  async createSession(conversationId: string, project: string, userPrompt: string): Promise<SessionData> {
    // Check if session already exists in memory
    if (this.sessions.has(conversationId)) {
      return this.sessions.get(conversationId)!;
    }

    // Create session in database
    const db = await this.getDb();

    try {
      // Use conversationId as the claude_session_id (maps to Claude Code's session_id)
      const result = db.prepare(`
        INSERT INTO sdk_sessions (claude_session_id, project, user_prompt, sdk_session_id, status, started_at, started_at_epoch)
        VALUES (?, ?, ?, NULL, 'active', datetime('now'), ?)
        ON CONFLICT(claude_session_id) DO UPDATE SET
          project = excluded.project,
          user_prompt = excluded.user_prompt
        RETURNING id
      `).get(conversationId, project, userPrompt, Date.now());

      const sessionDbId = (result as any).id;

      const sessionData: SessionData = {
        sessionDbId,
        conversationId,
        project,
        promptNumber: 1,
        startTime: Date.now()
      };

      this.sessions.set(conversationId, sessionData);
      return sessionData;
    } finally {
      db.close();
    }
  }

  /**
   * Get session by conversation ID
   */
  getSession(conversationId: string): SessionData | undefined {
    return this.sessions.get(conversationId);
  }

  /**
   * Increment prompt counter for a session
   */
  incrementPromptCounter(conversationId: string): number {
    const session = this.sessions.get(conversationId);
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`);
    }

    session.promptNumber++;
    return session.promptNumber;
  }

  /**
   * Get current prompt counter
   */
  getPromptCounter(conversationId: string): number {
    const session = this.sessions.get(conversationId);
    return session?.promptNumber || 1;
  }

  /**
   * Save user prompt to database for FTS search
   */
  async saveUserPrompt(conversationId: string, promptNumber: number, promptText: string): Promise<void> {
    const db = await this.getDb();

    try {
      db.prepare(`
        INSERT INTO user_prompts (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
        VALUES (?, ?, ?, datetime('now'), ?)
      `).run(conversationId, promptNumber, promptText, Date.now());
    } finally {
      db.close();
    }
  }

  /**
   * Mark session as complete
   */
  async completeSession(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) {
      return; // Already cleaned up or never existed
    }

    const db = await this.getDb();

    try {
      db.prepare(`
        UPDATE sdk_sessions
        SET status = 'completed',
            completed_at = datetime('now'),
            completed_at_epoch = ?
        WHERE id = ?
      `).run(Date.now(), session.sessionDbId);
    } finally {
      db.close();
    }

    // Remove from memory
    this.sessions.delete(conversationId);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): SessionData[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Clear all sessions (for testing/debugging)
   */
  clearAll(): void {
    this.sessions.clear();
  }
}
