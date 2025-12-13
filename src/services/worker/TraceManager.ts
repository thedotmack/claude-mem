/**
 * TraceManager - Manages execution traces for tool/skill/MCP tracking
 */

import { SessionStore } from '../sqlite/SessionStore.js';
import { ExecutionTraceRow, ExecutionTraceInput } from '../sqlite/types.js';
import { logger } from '../../utils/logger.js';

export class TraceManager {
    private sessionStore: SessionStore;
    private traceCounters: Map<string, number> = new Map(); // session -> step_order counter

    constructor(sessionStore: SessionStore) {
        this.sessionStore = sessionStore;
    }

    /**
     * Record an execution trace
     */
    recordTrace(input: ExecutionTraceInput): number {
        const now = new Date();
        const nowEpoch = now.getTime();

        // Auto-increment step_order per session if not provided
        let stepOrder = input.step_order;
        if (stepOrder === undefined || stepOrder === 0) {
            const currentCount = this.traceCounters.get(input.sdk_session_id) || 0;
            stepOrder = currentCount + 1;
            this.traceCounters.set(input.sdk_session_id, stepOrder);
        }

        try {
            const stmt = this.sessionStore.db.prepare(`
        INSERT INTO execution_traces 
        (sdk_session_id, prompt_number, step_order, trace_type, name, source, 
         input_summary, output_summary, duration_ms, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

            const result = stmt.run(
                input.sdk_session_id,
                input.prompt_number || null,
                stepOrder,
                input.trace_type,
                input.name,
                input.source || null,
                this.truncate(input.input_summary, 500),
                this.truncate(input.output_summary, 500),
                input.duration_ms || null,
                now.toISOString(),
                nowEpoch
            );

            logger.debug('TRACE', `Recorded ${input.trace_type}: ${input.name}`, {
                sessionId: input.sdk_session_id,
                stepOrder
            });

            return Number(result.lastInsertRowid);
        } catch (error) {
            logger.warn('TRACE', 'Failed to record trace', { name: input.name }, error as Error);
            return -1;
        }
    }

    /**
     * Get traces for a specific prompt in a session
     */
    getTracesForPrompt(sdk_session_id: string, prompt_number: number): ExecutionTraceRow[] {
        try {
            const stmt = this.sessionStore.db.prepare(`
        SELECT * FROM execution_traces 
        WHERE sdk_session_id = ? AND prompt_number = ?
        ORDER BY step_order ASC
      `);
            return stmt.all(sdk_session_id, prompt_number) as ExecutionTraceRow[];
        } catch (error) {
            logger.warn('TRACE', 'Failed to get traces for prompt', { sdk_session_id, prompt_number }, error as Error);
            return [];
        }
    }

    /**
     * Get all traces for a session
     */
    getTracesForSession(sdk_session_id: string): ExecutionTraceRow[] {
        try {
            const stmt = this.sessionStore.db.prepare(`
        SELECT * FROM execution_traces 
        WHERE sdk_session_id = ?
        ORDER BY step_order ASC
      `);
            return stmt.all(sdk_session_id) as ExecutionTraceRow[];
        } catch (error) {
            logger.warn('TRACE', 'Failed to get traces for session', { sdk_session_id }, error as Error);
            return [];
        }
    }

    /**
     * Get recent traces across all sessions
     */
    getRecentTraces(limit: number = 100): ExecutionTraceRow[] {
        try {
            const stmt = this.sessionStore.db.prepare(`
        SELECT * FROM execution_traces 
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `);
            return stmt.all(limit) as ExecutionTraceRow[];
        } catch (error) {
            logger.warn('TRACE', 'Failed to get recent traces', {}, error as Error);
            return [];
        }
    }

    /**
     * Clear trace counter for a session (call when session ends)
     */
    clearSessionCounter(sdk_session_id: string): void {
        this.traceCounters.delete(sdk_session_id);
    }

    /**
     * Truncate string to max length
     */
    private truncate(str: string | undefined, maxLen: number): string | null {
        if (!str) return null;
        if (str.length <= maxLen) return str;
        return str.substring(0, maxLen - 3) + '...';
    }
}
