/**
 * ProConfig
 *
 * Manages Claude-Mem Pro configuration and user detection.
 * Pro configuration is stored in ~/.claude-mem/pro.json
 *
 * Configuration is set by the /pro-setup skill which:
 * 1. Validates the setup token with mem-pro API
 * 2. Stores the configuration locally
 * 3. Enables cloud sync
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { logger } from '../../utils/logger.js';

export interface MigrationStatus {
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
  startedAt?: number;
  completedAt?: number;
  error?: string;
  stats?: {
    observationsMigrated: number;
    summariesMigrated: number;
    promptsMigrated: number;
    vectorsMigrated: number;
  };
}

export interface ProUserConfig {
  userId: string;
  setupToken: string;
  apiUrl: string;
  pineconeNamespace: string;
  configuredAt: number;
  expiresAt: number;
  planTier: 'pro' | 'enterprise';
  migration?: MigrationStatus;
}

const PRO_CONFIG_PATH = join(homedir(), '.claude-mem', 'pro.json');

/**
 * Load Pro user configuration from disk
 * Returns null if not a Pro user or config is invalid/expired
 */
export function loadProConfig(): ProUserConfig | null {
  try {
    if (!existsSync(PRO_CONFIG_PATH)) {
      return null;
    }

    const content = readFileSync(PRO_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(content) as ProUserConfig;

    // Validate required fields
    if (!config.userId || !config.setupToken || !config.apiUrl) {
      logger.warn('PRO_CONFIG', 'Invalid Pro config: missing required fields');
      return null;
    }

    // Check if expired
    if (config.expiresAt && Date.now() > config.expiresAt) {
      logger.warn('PRO_CONFIG', 'Pro config expired', {
        expiresAt: new Date(config.expiresAt).toISOString()
      });
      return null;
    }

    logger.info('PRO_CONFIG', 'Loaded Pro user config', {
      userId: config.userId.substring(0, 8) + '...',
      planTier: config.planTier
    });

    return config;
  } catch (error) {
    logger.error('PRO_CONFIG', 'Failed to load Pro config', {}, error as Error);
    return null;
  }
}

/**
 * Save Pro user configuration to disk
 */
export function saveProConfig(config: ProUserConfig): void {
  try {
    const dir = dirname(PRO_CONFIG_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(PRO_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');

    logger.info('PRO_CONFIG', 'Saved Pro user config', {
      userId: config.userId.substring(0, 8) + '...',
      planTier: config.planTier
    });
  } catch (error) {
    logger.error('PRO_CONFIG', 'Failed to save Pro config', {}, error as Error);
    throw error;
  }
}

/**
 * Update migration status in Pro config
 * This allows tracking migration progress and errors
 */
export function updateMigrationStatus(status: MigrationStatus): void {
  const config = loadProConfig();
  if (!config) {
    logger.warn('PRO_CONFIG', 'Cannot update migration status: no Pro config');
    return;
  }

  config.migration = status;
  saveProConfig(config);

  logger.info('PRO_CONFIG', 'Updated migration status', {
    status: status.status,
    error: status.error
  });
}

/**
 * Remove Pro configuration (for logout/downgrade)
 */
export function removeProConfig(): void {
  try {
    if (existsSync(PRO_CONFIG_PATH)) {
      unlinkSync(PRO_CONFIG_PATH);
      logger.info('PRO_CONFIG', 'Removed Pro config');
    }
  } catch (error) {
    logger.error('PRO_CONFIG', 'Failed to remove Pro config', {}, error as Error);
  }
}

/**
 * Check if user is a Pro user
 */
export function isProUser(): boolean {
  const config = loadProConfig();
  return config !== null;
}

/**
 * Initialize Pro account with mem-pro API
 * Validates token and ensures Pinecone namespace is ready
 * Returns user info if valid, throws error if invalid
 */
export async function initializeProAccount(
  apiUrl: string,
  setupToken: string
): Promise<{
  success: boolean;
  userId: string;
  pineconeNamespace: string;
  planTier: 'pro' | 'enterprise';
  expiresAt: number;
  pineconeReady: boolean;
  currentVectors: number;
  setupCompleted: boolean;
  apiUrl: string;
}> {
  const response = await fetch(`${apiUrl}/api/pro/initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ setupToken })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token validation failed: ${response.status} - ${errorText}`);
  }

  return response.json();
}

/**
 * Legacy: Validate setup token with mem-pro API
 * @deprecated Use initializeProAccount instead
 */
export async function validateSetupToken(
  apiUrl: string,
  setupToken: string
): Promise<{
  userId: string;
  pineconeNamespace: string;
  planTier: 'pro' | 'enterprise';
  expiresAt: number;
}> {
  const response = await fetch(`${apiUrl}/api/pro/validate-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ setupToken })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token validation failed: ${response.status} - ${errorText}`);
  }

  return response.json();
}

/**
 * Setup Pro user from setup token
 * Validates token, initializes Pinecone, and saves configuration
 */
export async function setupProUser(
  apiUrl: string,
  setupToken: string
): Promise<ProUserConfig & { setupCompleted: boolean; currentVectors: number }> {
  logger.info('PRO_CONFIG', 'Setting up Pro user', { apiUrl });

  // Initialize Pro account (validates token + creates Pinecone namespace)
  const init = await initializeProAccount(apiUrl, setupToken);

  // Create config
  const config: ProUserConfig = {
    userId: init.userId,
    setupToken,
    apiUrl: init.apiUrl || apiUrl, // Use returned apiUrl for multi-environment support
    pineconeNamespace: init.pineconeNamespace,
    configuredAt: Date.now(),
    expiresAt: init.expiresAt,
    planTier: init.planTier
  };

  // Save config
  saveProConfig(config);

  logger.info('PRO_CONFIG', 'Pro user setup complete', {
    userId: config.userId.substring(0, 8) + '...',
    planTier: config.planTier,
    pineconeReady: init.pineconeReady,
    setupCompleted: init.setupCompleted
  });

  return {
    ...config,
    setupCompleted: init.setupCompleted,
    currentVectors: init.currentVectors
  };
}

/**
 * Complete Pro setup by notifying mem-pro API
 * Called after migration is complete
 */
export async function completeProSetup(
  apiUrl: string,
  setupToken: string,
  migrationStats: {
    observationsMigrated: number;
    summariesMigrated: number;
    promptsMigrated: number;
    vectorsMigrated: number;
  }
): Promise<void> {
  logger.info('PRO_CONFIG', 'Completing Pro setup', {
    stats: migrationStats
  });

  const response = await fetch(`${apiUrl}/api/pro/complete-setup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      setup_token: setupToken,
      observations_migrated: migrationStats.observationsMigrated,
      summaries_migrated: migrationStats.summariesMigrated,
      prompts_migrated: migrationStats.promptsMigrated,
      vectors_migrated: migrationStats.vectorsMigrated
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Complete setup failed: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  logger.info('PRO_CONFIG', 'Pro setup marked complete', result);
}
