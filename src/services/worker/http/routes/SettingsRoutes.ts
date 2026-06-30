
import express, { Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import { readFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import { getPackageRoot, paths } from '../../../../shared/paths.js';
import { logger } from '../../../../utils/logger.js';
import { SettingsManager } from '../../SettingsManager.js';
import { getBranchInfo, switchBranch, pullUpdates } from '../../BranchManager.js';
import { ModeManager } from '../../../domain/ModeManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { SettingsDefaultsManager, writeSettingsFileSecure } from '../../../../shared/SettingsDefaultsManager.js';
import { clearPortCache } from '../../../../shared/worker-utils.js';
import { flushResponseThen } from '../../../server/flushResponseThen.js';
import { snapshotDependencyHealth } from '../../../../shared/dependency-health.js';

const toggleMcpSchema = z.object({
  enabled: z.boolean(),
}).passthrough();

const switchBranchSchema = z.object({
  branch: z.string().min(1),
}).passthrough();

export class SettingsRoutes extends BaseRouteHandler {
  constructor(
    private settingsManager: SettingsManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/settings', this.handleGetSettings.bind(this));
    app.post('/api/settings', this.handleUpdateSettings.bind(this));
    app.get('/api/settings/dependency-health', this.handleGetDependencyHealth.bind(this));

    app.get('/api/mcp/status', this.handleGetMcpStatus.bind(this));
    app.post('/api/mcp/toggle', validateBody(toggleMcpSchema), this.handleToggleMcp.bind(this));

    app.get('/api/branch/status', this.handleGetBranchStatus.bind(this));
    app.post('/api/branch/switch', validateBody(switchBranchSchema), this.handleSwitchBranch.bind(this));
    app.post('/api/branch/update', this.handleUpdateBranch.bind(this));
  }

  private handleGetSettings = this.wrapHandler((req: Request, res: Response): void => {
    const settingsPath = paths.settings();
    this.ensureSettingsFile(settingsPath);
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    res.json(settings);
  });

  private handleGetDependencyHealth = this.wrapHandler((_req: Request, res: Response): void => {
    res.json(snapshotDependencyHealth());
  });

  private handleUpdateSettings = this.wrapHandler((req: Request, res: Response): void => {
    const validation = this.validateSettings(req.body);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: validation.error
      });
      return;
    }

    const settingsPath = paths.settings();
    this.ensureSettingsFile(settingsPath);
    let settings: any = {};

    if (existsSync(settingsPath)) {
      const settingsData = readFileSync(settingsPath, 'utf-8');
      try {
        settings = JSON.parse(settingsData);
      } catch (parseError) {
        const normalizedParseError = parseError instanceof Error ? parseError : new Error(String(parseError));
        logger.error('HTTP', 'Failed to parse settings file', { settingsPath }, normalizedParseError);
        res.status(500).json({
          success: false,
          error: `Settings file is corrupted. Delete ${settingsPath} to reset.`
        });
        return;
      }
    }

    const requestedSettings = req.body as Record<string, unknown>;
    settings = {
      ...settings,
      ...(requestedSettings.CLAUDE_MEM_MODEL !== undefined ? { CLAUDE_MEM_MODEL: requestedSettings.CLAUDE_MEM_MODEL } : {}),
      ...(requestedSettings.CLAUDE_MEM_CONTEXT_OBSERVATIONS !== undefined ? { CLAUDE_MEM_CONTEXT_OBSERVATIONS: requestedSettings.CLAUDE_MEM_CONTEXT_OBSERVATIONS } : {}),
      ...(requestedSettings.CLAUDE_MEM_WORKER_PORT !== undefined ? { CLAUDE_MEM_WORKER_PORT: requestedSettings.CLAUDE_MEM_WORKER_PORT } : {}),
      ...(requestedSettings.CLAUDE_MEM_WORKER_HOST !== undefined ? { CLAUDE_MEM_WORKER_HOST: requestedSettings.CLAUDE_MEM_WORKER_HOST } : {}),
      ...(requestedSettings.CLAUDE_MEM_PROVIDER !== undefined ? { CLAUDE_MEM_PROVIDER: requestedSettings.CLAUDE_MEM_PROVIDER } : {}),
      ...(requestedSettings.CLAUDE_MEM_CLAUDE_AUTH_METHOD !== undefined ? { CLAUDE_MEM_CLAUDE_AUTH_METHOD: requestedSettings.CLAUDE_MEM_CLAUDE_AUTH_METHOD } : {}),
      ...(requestedSettings.CLAUDE_MEM_GEMINI_API_KEY !== undefined ? { CLAUDE_MEM_GEMINI_API_KEY: requestedSettings.CLAUDE_MEM_GEMINI_API_KEY } : {}),
      ...(requestedSettings.CLAUDE_MEM_GEMINI_MODEL !== undefined ? { CLAUDE_MEM_GEMINI_MODEL: requestedSettings.CLAUDE_MEM_GEMINI_MODEL } : {}),
      ...(requestedSettings.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED !== undefined ? { CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: requestedSettings.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED } : {}),
      ...(requestedSettings.CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES !== undefined ? { CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES: requestedSettings.CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES } : {}),
      ...(requestedSettings.CLAUDE_MEM_GEMINI_MAX_TOKENS !== undefined ? { CLAUDE_MEM_GEMINI_MAX_TOKENS: requestedSettings.CLAUDE_MEM_GEMINI_MAX_TOKENS } : {}),
      ...(requestedSettings.CLAUDE_MEM_OPENROUTER_API_KEY !== undefined ? { CLAUDE_MEM_OPENROUTER_API_KEY: requestedSettings.CLAUDE_MEM_OPENROUTER_API_KEY } : {}),
      ...(requestedSettings.CLAUDE_MEM_OPENROUTER_MODEL !== undefined ? { CLAUDE_MEM_OPENROUTER_MODEL: requestedSettings.CLAUDE_MEM_OPENROUTER_MODEL } : {}),
      ...(requestedSettings.CLAUDE_MEM_OPENROUTER_SITE_URL !== undefined ? { CLAUDE_MEM_OPENROUTER_SITE_URL: requestedSettings.CLAUDE_MEM_OPENROUTER_SITE_URL } : {}),
      ...(requestedSettings.CLAUDE_MEM_OPENROUTER_APP_NAME !== undefined ? { CLAUDE_MEM_OPENROUTER_APP_NAME: requestedSettings.CLAUDE_MEM_OPENROUTER_APP_NAME } : {}),
      ...(requestedSettings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES !== undefined ? { CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: requestedSettings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES } : {}),
      ...(requestedSettings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS !== undefined ? { CLAUDE_MEM_OPENROUTER_MAX_TOKENS: requestedSettings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS } : {}),
      ...(requestedSettings.CLAUDE_MEM_CODEX_MODEL !== undefined ? { CLAUDE_MEM_CODEX_MODEL: requestedSettings.CLAUDE_MEM_CODEX_MODEL } : {}),
      ...(requestedSettings.CLAUDE_MEM_CODEX_PATH !== undefined ? { CLAUDE_MEM_CODEX_PATH: requestedSettings.CLAUDE_MEM_CODEX_PATH } : {}),
      ...(requestedSettings.CLAUDE_MEM_CODEX_REASONING_EFFORT !== undefined ? { CLAUDE_MEM_CODEX_REASONING_EFFORT: requestedSettings.CLAUDE_MEM_CODEX_REASONING_EFFORT } : {}),
      ...(requestedSettings.CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES !== undefined ? { CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES: requestedSettings.CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES } : {}),
      ...(requestedSettings.CLAUDE_MEM_CODEX_MAX_TOKENS !== undefined ? { CLAUDE_MEM_CODEX_MAX_TOKENS: requestedSettings.CLAUDE_MEM_CODEX_MAX_TOKENS } : {}),
      ...(requestedSettings.CLAUDE_MEM_CODEX_TIMEOUT_MS !== undefined ? { CLAUDE_MEM_CODEX_TIMEOUT_MS: requestedSettings.CLAUDE_MEM_CODEX_TIMEOUT_MS } : {}),
      ...(requestedSettings.CLAUDE_MEM_DATA_DIR !== undefined ? { CLAUDE_MEM_DATA_DIR: requestedSettings.CLAUDE_MEM_DATA_DIR } : {}),
      ...(requestedSettings.CLAUDE_MEM_LOG_LEVEL !== undefined ? { CLAUDE_MEM_LOG_LEVEL: requestedSettings.CLAUDE_MEM_LOG_LEVEL } : {}),
      ...(requestedSettings.CLAUDE_MEM_PYTHON_VERSION !== undefined ? { CLAUDE_MEM_PYTHON_VERSION: requestedSettings.CLAUDE_MEM_PYTHON_VERSION } : {}),
      ...(requestedSettings.CLAUDE_CODE_PATH !== undefined ? { CLAUDE_CODE_PATH: requestedSettings.CLAUDE_CODE_PATH } : {}),
      ...(requestedSettings.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS !== undefined ? { CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: requestedSettings.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS } : {}),
      ...(requestedSettings.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS !== undefined ? { CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: requestedSettings.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS } : {}),
      ...(requestedSettings.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT !== undefined ? { CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: requestedSettings.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT } : {}),
      ...(requestedSettings.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT !== undefined ? { CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: requestedSettings.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT } : {}),
      ...(requestedSettings.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES !== undefined ? { CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES: requestedSettings.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES } : {}),
      ...(requestedSettings.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS !== undefined ? { CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS: requestedSettings.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS } : {}),
      ...(requestedSettings.CLAUDE_MEM_CONTEXT_FULL_COUNT !== undefined ? { CLAUDE_MEM_CONTEXT_FULL_COUNT: requestedSettings.CLAUDE_MEM_CONTEXT_FULL_COUNT } : {}),
      ...(requestedSettings.CLAUDE_MEM_CONTEXT_FULL_FIELD !== undefined ? { CLAUDE_MEM_CONTEXT_FULL_FIELD: requestedSettings.CLAUDE_MEM_CONTEXT_FULL_FIELD } : {}),
      ...(requestedSettings.CLAUDE_MEM_CONTEXT_SESSION_COUNT !== undefined ? { CLAUDE_MEM_CONTEXT_SESSION_COUNT: requestedSettings.CLAUDE_MEM_CONTEXT_SESSION_COUNT } : {}),
      ...(requestedSettings.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY !== undefined ? { CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: requestedSettings.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY } : {}),
      ...(requestedSettings.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE !== undefined ? { CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: requestedSettings.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE } : {}),
      ...(requestedSettings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED !== undefined ? { CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: requestedSettings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED } : {}),
    };

    writeSettingsFileSecure(settingsPath, settings);

    clearPortCache();

    logger.info('WORKER', 'Settings updated');
    res.json({ success: true, message: 'Settings updated successfully' });
  });

  private handleGetMcpStatus = this.wrapHandler((req: Request, res: Response): void => {
    const enabled = this.isMcpEnabled();
    res.json({ enabled });
  });

  private handleToggleMcp = this.wrapHandler((req: Request, res: Response): void => {
    const { enabled } = req.body as z.infer<typeof toggleMcpSchema>;

    this.toggleMcp(enabled);
    res.json({ success: true, enabled: this.isMcpEnabled() });
  });

  private handleGetBranchStatus = this.wrapHandler((req: Request, res: Response): void => {
    const info = getBranchInfo();
    res.json(info);
  });

  private handleSwitchBranch = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { branch } = req.body as z.infer<typeof switchBranchSchema>;

    const allowedBranches = ['main', 'beta/7.0', 'feature/bun-executable'];
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
      flushResponseThen(res, result, () => {
        logger.info('WORKER', 'Restarting worker after branch switch');
      });
    } else {
      res.json(result);
    }
  });

  private handleUpdateBranch = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    logger.info('WORKER', 'Branch update requested');

    const result = await pullUpdates();

    if (result.success) {
      flushResponseThen(res, result, () => {
        logger.info('WORKER', 'Restarting worker after branch update');
      });
    } else {
      res.json(result);
    }
  });

  private validateSettings(settings: any): { valid: boolean; error?: string } {
    if (settings.CLAUDE_MEM_PROVIDER) {
      const validProviders = ['claude', 'gemini', 'openrouter', 'codex'];
      if (!validProviders.includes(settings.CLAUDE_MEM_PROVIDER)) {
        return { valid: false, error: 'CLAUDE_MEM_PROVIDER must be "claude", "gemini", "openrouter", or "codex"' };
      }
    }

    if (settings.CLAUDE_MEM_CLAUDE_AUTH_METHOD) {
      const validClaudeAuthMethods = ['subscription', 'api-key', 'gateway', 'cli'];
      if (!validClaudeAuthMethods.includes(settings.CLAUDE_MEM_CLAUDE_AUTH_METHOD)) {
        return { valid: false, error: 'CLAUDE_MEM_CLAUDE_AUTH_METHOD must be "subscription", "api-key", "gateway", or "cli"' };
      }
    }

    if (settings.CLAUDE_MEM_GEMINI_MODEL) {
      const validGeminiModels = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3-flash-preview'];
      if (!validGeminiModels.includes(settings.CLAUDE_MEM_GEMINI_MODEL)) {
        return { valid: false, error: 'CLAUDE_MEM_GEMINI_MODEL must be one of: gemini-2.5-flash-lite, gemini-2.5-flash, gemini-3-flash-preview' };
      }
    }

    if (settings.CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES) {
      const count = parseInt(settings.CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES, 10);
      if (isNaN(count) || count < 1 || count > 100) {
        return { valid: false, error: 'CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES must be between 1 and 100' };
      }
    }

    if (settings.CLAUDE_MEM_GEMINI_MAX_TOKENS) {
      const tokens = parseInt(settings.CLAUDE_MEM_GEMINI_MAX_TOKENS, 10);
      if (isNaN(tokens) || tokens < 1000 || tokens > 1000000) {
        return { valid: false, error: 'CLAUDE_MEM_GEMINI_MAX_TOKENS must be between 1000 and 1000000' };
      }
    }

    if (settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS) {
      const obsCount = parseInt(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10);
      if (isNaN(obsCount) || obsCount < 1 || obsCount > 200) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_OBSERVATIONS must be between 1 and 200' };
      }
    }

    if (settings.CLAUDE_MEM_WORKER_PORT) {
      const port = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        return { valid: false, error: 'CLAUDE_MEM_WORKER_PORT must be between 1024 and 65535' };
      }
    }

    if (settings.CLAUDE_MEM_WORKER_HOST) {
      const host = settings.CLAUDE_MEM_WORKER_HOST;
      const validHostPattern = /^(127\.0\.0\.1|0\.0\.0\.0|localhost|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
      if (!validHostPattern.test(host)) {
        return { valid: false, error: 'CLAUDE_MEM_WORKER_HOST must be a valid IP address (e.g., 127.0.0.1, 0.0.0.0)' };
      }
    }

    if (settings.CLAUDE_MEM_LOG_LEVEL) {
      const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'SILENT'];
      if (!validLevels.includes(settings.CLAUDE_MEM_LOG_LEVEL.toUpperCase())) {
        return { valid: false, error: 'CLAUDE_MEM_LOG_LEVEL must be one of: DEBUG, INFO, WARN, ERROR, SILENT' };
      }
    }

    if (settings.CLAUDE_MEM_PYTHON_VERSION) {
      const pythonVersionRegex = /^3\.\d{1,2}$/;
      if (!pythonVersionRegex.test(settings.CLAUDE_MEM_PYTHON_VERSION)) {
        return { valid: false, error: 'CLAUDE_MEM_PYTHON_VERSION must be in format "3.X" or "3.XX" (e.g., "3.13")' };
      }
    }

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

    if (settings.CLAUDE_MEM_CONTEXT_FULL_COUNT) {
      const count = parseInt(settings.CLAUDE_MEM_CONTEXT_FULL_COUNT, 10);
      if (isNaN(count) || count < 0 || count > 20) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_FULL_COUNT must be between 0 and 20' };
      }
    }

    if (settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT) {
      const count = parseInt(settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT, 10);
      if (isNaN(count) || count < 1 || count > 50) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_SESSION_COUNT must be between 1 and 50' };
      }
    }

    if (settings.CLAUDE_MEM_CONTEXT_FULL_FIELD) {
      if (!['narrative', 'facts'].includes(settings.CLAUDE_MEM_CONTEXT_FULL_FIELD)) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_FULL_FIELD must be "narrative" or "facts"' };
      }
    }

    if (settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES) {
      const count = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES, 10);
      if (isNaN(count) || count < 1 || count > 100) {
        return { valid: false, error: 'CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES must be between 1 and 100' };
      }
    }

    if (settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS) {
      const tokens = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS, 10);
      if (isNaN(tokens) || tokens < 1000 || tokens > 1000000) {
        return { valid: false, error: 'CLAUDE_MEM_OPENROUTER_MAX_TOKENS must be between 1000 and 1000000' };
      }
    }

    if (settings.CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES) {
      const count = parseInt(settings.CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES, 10);
      if (isNaN(count) || count < 1 || count > 100) {
        return { valid: false, error: 'CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES must be between 1 and 100' };
      }
    }

    if (settings.CLAUDE_MEM_CODEX_MAX_TOKENS) {
      const tokens = parseInt(settings.CLAUDE_MEM_CODEX_MAX_TOKENS, 10);
      if (isNaN(tokens) || tokens < 1000 || tokens > 1000000) {
        return { valid: false, error: 'CLAUDE_MEM_CODEX_MAX_TOKENS must be between 1000 and 1000000' };
      }
    }

    if (settings.CLAUDE_MEM_CODEX_REASONING_EFFORT) {
      const validEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh'];
      if (!validEfforts.includes(String(settings.CLAUDE_MEM_CODEX_REASONING_EFFORT).toLowerCase())) {
        return { valid: false, error: 'CLAUDE_MEM_CODEX_REASONING_EFFORT must be one of: minimal, low, medium, high, xhigh' };
      }
    }

    if (settings.CLAUDE_MEM_CODEX_TIMEOUT_MS) {
      const timeout = parseInt(settings.CLAUDE_MEM_CODEX_TIMEOUT_MS, 10);
      if (isNaN(timeout) || timeout < 10000 || timeout > 600000) {
        return { valid: false, error: 'CLAUDE_MEM_CODEX_TIMEOUT_MS must be between 10000 and 600000' };
      }
    }

    if (settings.CLAUDE_MEM_OPENROUTER_SITE_URL) {
      try {
        new URL(settings.CLAUDE_MEM_OPENROUTER_SITE_URL);
      } catch (error) {
        logger.debug('SETTINGS', 'Invalid URL format', { url: settings.CLAUDE_MEM_OPENROUTER_SITE_URL, error: error instanceof Error ? error.message : String(error) });
        return { valid: false, error: 'CLAUDE_MEM_OPENROUTER_SITE_URL must be a valid URL' };
      }
    }

    return { valid: true };
  }

  private isMcpEnabled(): boolean {
    const packageRoot = getPackageRoot();
    const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
    return existsSync(mcpPath);
  }

  private toggleMcp(enabled: boolean): void {
    const packageRoot = getPackageRoot();
    const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
    const mcpDisabledPath = path.join(packageRoot, 'plugin', '.mcp.json.disabled');

    if (enabled && existsSync(mcpDisabledPath)) {
      renameSync(mcpDisabledPath, mcpPath);
      logger.info('WORKER', 'MCP search server enabled');
    } else if (!enabled && existsSync(mcpPath)) {
      renameSync(mcpPath, mcpDisabledPath);
      logger.info('WORKER', 'MCP search server disabled');
    } else {
      logger.debug('WORKER', 'MCP toggle no-op (already in desired state)', { enabled });
    }
  }

  private ensureSettingsFile(settingsPath: string): void {
    if (!existsSync(settingsPath)) {
      const defaults = SettingsDefaultsManager.getAllDefaults();

      const dir = path.dirname(settingsPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeSettingsFileSecure(settingsPath, defaults);
      logger.info('SETTINGS', 'Created settings file with defaults', { settingsPath });
    }
  }
}
