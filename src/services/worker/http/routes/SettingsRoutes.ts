/**
 * Settings Routes
 *
 * Handles settings management, MCP toggle, and branch switching.
 * Settings are stored in ~/.claude-mem/settings.json
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { homedir } from 'os';
import { getPackageRoot } from '../../../../shared/paths.js';
import { logger } from '../../../../utils/logger.js';
import { SettingsManager } from '../../SettingsManager.js';
import { getBranchInfo, switchBranch, pullUpdates } from '../../BranchManager.js';
import {
  OBSERVATION_TYPES,
  OBSERVATION_CONCEPTS,
  DEFAULT_OBSERVATION_TYPES_STRING,
  DEFAULT_OBSERVATION_CONCEPTS_STRING,
  ObservationType,
  ObservationConcept
} from '../../../../constants/observation-metadata.js';

export class SettingsRoutes {
  constructor(
    private settingsManager: SettingsManager
  ) {}

  setupRoutes(app: express.Application): void {
    // Settings endpoints
    app.get('/api/settings', this.handleGetSettings.bind(this));
    app.post('/api/settings', this.handleUpdateSettings.bind(this));

    // MCP toggle endpoints
    app.get('/api/mcp/status', this.handleGetMcpStatus.bind(this));
    app.post('/api/mcp/toggle', this.handleToggleMcp.bind(this));

    // Branch switching endpoints
    app.get('/api/branch/status', this.handleGetBranchStatus.bind(this));
    app.post('/api/branch/switch', this.handleSwitchBranch.bind(this));
    app.post('/api/branch/update', this.handleUpdateBranch.bind(this));
  }

  /**
   * Get environment settings (from ~/.claude/settings.json)
   */
  private handleGetSettings(req: Request, res: Response): void {
    try {
      const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');

      if (!existsSync(settingsPath)) {
        // Return defaults if file doesn't exist
        res.json({
          CLAUDE_MEM_MODEL: 'claude-haiku-4-5',
          CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
          CLAUDE_MEM_WORKER_PORT: '37777',
          // Token Economics
          CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: 'true',
          CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: 'true',
          CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'true',
          CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',
          // Observation Filtering
          CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES: DEFAULT_OBSERVATION_TYPES_STRING,
          CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS: DEFAULT_OBSERVATION_CONCEPTS_STRING,
          // Display Configuration
          CLAUDE_MEM_CONTEXT_FULL_COUNT: '5',
          CLAUDE_MEM_CONTEXT_FULL_FIELD: 'narrative',
          CLAUDE_MEM_CONTEXT_SESSION_COUNT: '10',
          // Feature Toggles
          CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
          CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
        });
        return;
      }

      const settingsData = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsData);
      const env = settings.env || {};

      res.json({
        CLAUDE_MEM_MODEL: env.CLAUDE_MEM_MODEL || 'claude-haiku-4-5',
        CLAUDE_MEM_CONTEXT_OBSERVATIONS: env.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50',
        CLAUDE_MEM_WORKER_PORT: env.CLAUDE_MEM_WORKER_PORT || '37777',
        // Token Economics
        CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: env.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS || 'true',
        CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: env.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS || 'true',
        CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: env.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT || 'true',
        CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: env.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT || 'true',
        // Observation Filtering
        CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES: env.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES || DEFAULT_OBSERVATION_TYPES_STRING,
        CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS: env.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS || DEFAULT_OBSERVATION_CONCEPTS_STRING,
        // Display Configuration
        CLAUDE_MEM_CONTEXT_FULL_COUNT: env.CLAUDE_MEM_CONTEXT_FULL_COUNT || '5',
        CLAUDE_MEM_CONTEXT_FULL_FIELD: env.CLAUDE_MEM_CONTEXT_FULL_FIELD || 'narrative',
        CLAUDE_MEM_CONTEXT_SESSION_COUNT: env.CLAUDE_MEM_CONTEXT_SESSION_COUNT || '10',
        // Feature Toggles
        CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: env.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY || 'true',
        CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: env.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE || 'false',
      });
    } catch (error) {
      logger.failure('WORKER', 'Get settings failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Update environment settings (in ~/.claude/settings.json) with validation
   */
  private handleUpdateSettings(req: Request, res: Response): void {
    try {
      // Validate CLAUDE_MEM_CONTEXT_OBSERVATIONS
      if (req.body.CLAUDE_MEM_CONTEXT_OBSERVATIONS) {
        const obsCount = parseInt(req.body.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10);
        if (isNaN(obsCount) || obsCount < 1 || obsCount > 200) {
          res.status(400).json({
            success: false,
            error: 'CLAUDE_MEM_CONTEXT_OBSERVATIONS must be between 1 and 200'
          });
          return;
        }
      }

      // Validate CLAUDE_MEM_WORKER_PORT
      if (req.body.CLAUDE_MEM_WORKER_PORT) {
        const port = parseInt(req.body.CLAUDE_MEM_WORKER_PORT, 10);
        if (isNaN(port) || port < 1024 || port > 65535) {
          res.status(400).json({
            success: false,
            error: 'CLAUDE_MEM_WORKER_PORT must be between 1024 and 65535'
          });
          return;
        }
      }

      // Validate context settings
      const validation = this.validateContextSettings(req.body);
      if (!validation.valid) {
        res.status(400).json({
          success: false,
          error: validation.error
        });
        return;
      }

      // Read existing settings
      const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
      let settings: any = { env: {} };

      if (existsSync(settingsPath)) {
        const settingsData = readFileSync(settingsPath, 'utf-8');
        settings = JSON.parse(settingsData);
        if (!settings.env) {
          settings.env = {};
        }
      }

      // Update all settings from request body
      const settingKeys = [
        'CLAUDE_MEM_MODEL',
        'CLAUDE_MEM_CONTEXT_OBSERVATIONS',
        'CLAUDE_MEM_WORKER_PORT',
        'CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS',
        'CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS',
        'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
        'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT',
        'CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES',
        'CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS',
        'CLAUDE_MEM_CONTEXT_FULL_COUNT',
        'CLAUDE_MEM_CONTEXT_FULL_FIELD',
        'CLAUDE_MEM_CONTEXT_SESSION_COUNT',
        'CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY',
        'CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE',
      ];

      for (const key of settingKeys) {
        if (req.body[key] !== undefined) {
          settings.env[key] = req.body[key];
        }
      }

      // Write back
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

      logger.info('WORKER', 'Settings updated');
      res.json({ success: true, message: 'Settings updated successfully' });
    } catch (error) {
      logger.failure('WORKER', 'Update settings failed', {}, error as Error);
      res.status(500).json({ success: false, error: String(error) });
    }
  }

  /**
   * GET /api/mcp/status - Check if MCP search server is enabled
   */
  private handleGetMcpStatus(req: Request, res: Response): void {
    try {
      const enabled = this.isMcpEnabled();
      res.json({ enabled });
    } catch (error) {
      logger.failure('WORKER', 'Get MCP status failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * POST /api/mcp/toggle - Toggle MCP search server on/off
   * Body: { enabled: boolean }
   */
  private handleToggleMcp(req: Request, res: Response): void {
    try {
      const { enabled } = req.body;

      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }

      this.toggleMcp(enabled);
      res.json({ success: true, enabled: this.isMcpEnabled() });
    } catch (error) {
      logger.failure('WORKER', 'Toggle MCP failed', {}, error as Error);
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  /**
   * GET /api/branch/status - Get current branch information
   */
  private handleGetBranchStatus(req: Request, res: Response): void {
    try {
      const info = getBranchInfo();
      res.json(info);
    } catch (error) {
      logger.failure('WORKER', 'Failed to get branch status', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * POST /api/branch/switch - Switch to a different branch
   * Body: { branch: "main" | "beta/7.0" }
   */
  private async handleSwitchBranch(req: Request, res: Response): Promise<void> {
    try {
      const { branch } = req.body;

      if (!branch) {
        res.status(400).json({ success: false, error: 'Missing branch parameter' });
        return;
      }

      // Validate branch name
      const allowedBranches = ['main', 'beta/7.0'];
      if (!allowedBranches.includes(branch)) {
        res.status(400).json({
          success: false,
          error: `Invalid branch. Allowed: ${allowedBranches.join(', ')}`
        });
        return;
      }

      logger.info('WORKER', 'Branch switch requested', { branch });

      const result = await switchBranch(branch);

      if (result.success) {
        // Schedule worker restart after response is sent
        setTimeout(() => {
          logger.info('WORKER', 'Restarting worker after branch switch');
          process.exit(0); // PM2 will restart the worker
        }, 1000);
      }

      res.json(result);
    } catch (error) {
      logger.failure('WORKER', 'Branch switch failed', {}, error as Error);
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  /**
   * POST /api/branch/update - Pull latest updates for current branch
   */
  private async handleUpdateBranch(req: Request, res: Response): Promise<void> {
    try {
      logger.info('WORKER', 'Branch update requested');

      const result = await pullUpdates();

      if (result.success) {
        // Schedule worker restart after response is sent
        setTimeout(() => {
          logger.info('WORKER', 'Restarting worker after branch update');
          process.exit(0); // PM2 will restart the worker
        }, 1000);
      }

      res.json(result);
    } catch (error) {
      logger.failure('WORKER', 'Branch update failed', {}, error as Error);
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  /**
   * Validate context settings from request body
   */
  private validateContextSettings(settings: any): { valid: boolean; error?: string } {
    // Validate boolean string values
    const booleanSettings = [
      'CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE',
    ];

    for (const key of booleanSettings) {
      if (settings[key] && !['true', 'false'].includes(settings[key])) {
        return { valid: false, error: `${key} must be "true" or "false"` };
      }
    }

    // Validate FULL_COUNT (0-20)
    if (settings.CLAUDE_MEM_CONTEXT_FULL_COUNT) {
      const count = parseInt(settings.CLAUDE_MEM_CONTEXT_FULL_COUNT, 10);
      if (isNaN(count) || count < 0 || count > 20) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_FULL_COUNT must be between 0 and 20' };
      }
    }

    // Validate SESSION_COUNT (1-50)
    if (settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT) {
      const count = parseInt(settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT, 10);
      if (isNaN(count) || count < 1 || count > 50) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_SESSION_COUNT must be between 1 and 50' };
      }
    }

    // Validate FULL_FIELD
    if (settings.CLAUDE_MEM_CONTEXT_FULL_FIELD) {
      if (!['narrative', 'facts'].includes(settings.CLAUDE_MEM_CONTEXT_FULL_FIELD)) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_FULL_FIELD must be "narrative" or "facts"' };
      }
    }

    // Validate observation types
    if (settings.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES) {
      const types = settings.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES.split(',').map((t: string) => t.trim());
      for (const type of types) {
        if (type && !OBSERVATION_TYPES.includes(type as ObservationType)) {
          return { valid: false, error: `Invalid observation type: ${type}. Valid types: ${OBSERVATION_TYPES.join(', ')}` };
        }
      }
    }

    // Validate observation concepts
    if (settings.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS) {
      const concepts = settings.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS.split(',').map((c: string) => c.trim());
      for (const concept of concepts) {
        if (concept && !OBSERVATION_CONCEPTS.includes(concept as ObservationConcept)) {
          return { valid: false, error: `Invalid observation concept: ${concept}. Valid concepts: ${OBSERVATION_CONCEPTS.join(', ')}` };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Check if MCP search server is enabled
   */
  private isMcpEnabled(): boolean {
    const packageRoot = getPackageRoot();
    const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
    return existsSync(mcpPath);
  }

  /**
   * Toggle MCP search server (rename .mcp.json <-> .mcp.json.disabled)
   */
  private toggleMcp(enabled: boolean): void {
    try {
      const packageRoot = getPackageRoot();
      const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
      const mcpDisabledPath = path.join(packageRoot, 'plugin', '.mcp.json.disabled');

      if (enabled && existsSync(mcpDisabledPath)) {
        // Enable: rename .mcp.json.disabled -> .mcp.json
        renameSync(mcpDisabledPath, mcpPath);
        logger.info('WORKER', 'MCP search server enabled');
      } else if (!enabled && existsSync(mcpPath)) {
        // Disable: rename .mcp.json -> .mcp.json.disabled
        renameSync(mcpPath, mcpDisabledPath);
        logger.info('WORKER', 'MCP search server disabled');
      } else {
        logger.debug('WORKER', 'MCP toggle no-op (already in desired state)', { enabled });
      }
    } catch (error) {
      logger.failure('WORKER', 'Failed to toggle MCP', { enabled }, error as Error);
      throw error;
    }
  }
}
