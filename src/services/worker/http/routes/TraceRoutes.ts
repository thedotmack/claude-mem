/**
 * Trace Routes - API endpoints for execution trace queries
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { TraceManager } from '../../TraceManager.js';

export class TraceRoutes extends BaseRouteHandler {
    constructor(private traceManager: TraceManager) {
        super();
    }

    setupRoutes(app: express.Application): void {
        // Get all traces for a session
        app.get('/api/traces/:session_id', this.handleGetSessionTraces.bind(this));

        // Get traces for a specific prompt
        app.get('/api/traces/:session_id/:prompt_number', this.handleGetPromptTraces.bind(this));

        // Get recent traces (for debugging)
        app.get('/api/traces', this.handleGetRecentTraces.bind(this));
    }

    /**
     * GET /api/traces/:session_id - Get all traces for a session
     */
    private handleGetSessionTraces = this.wrapHandler((req: Request, res: Response): void => {
        const { session_id } = req.params;
        const traces = this.traceManager.getTracesForSession(session_id);
        res.json({ traces, count: traces.length });
    });

    /**
     * GET /api/traces/:session_id/:prompt_number - Get traces for specific prompt
     */
    private handleGetPromptTraces = this.wrapHandler((req: Request, res: Response): void => {
        const { session_id, prompt_number } = req.params;
        const promptNum = parseInt(prompt_number, 10);

        if (isNaN(promptNum)) {
            this.badRequest(res, 'prompt_number must be a number');
            return;
        }

        const traces = this.traceManager.getTracesForPrompt(session_id, promptNum);
        res.json({ traces, count: traces.length });
    });

    /**
     * GET /api/traces - Get recent traces across all sessions
     */
    private handleGetRecentTraces = this.wrapHandler((req: Request, res: Response): void => {
        const limit = parseInt(req.query.limit as string, 10) || 100;
        const traces = this.traceManager.getRecentTraces(Math.min(limit, 500));
        res.json({ traces, count: traces.length });
    });
}
