/**
 * ModeManager - Singleton for loading and managing mode profiles
 *
 * Mode profiles define observation types, concepts, and prompts for different use cases.
 * Default mode is 'code' (software development). Other modes like 'email-investigation'
 * can be selected via CLAUDE_MEM_MODE setting.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';
import type { ModeConfig, ObservationType, ObservationConcept } from './types.js';
import { logger } from '../../utils/logger.js';
import { DATA_DIR } from '../../shared/paths.js';

export class ModeManager {
  private static instance: ModeManager | null = null;
  private activeMode: ModeConfig | null = null;
  private modesDir: string;

  private constructor() {
    this.modesDir = join(DATA_DIR, 'modes');
  }

  /**
   * Get singleton instance
   */
  static getInstance(): ModeManager {
    if (!ModeManager.instance) {
      ModeManager.instance = new ModeManager();
    }
    return ModeManager.instance;
  }

  /**
   * Load a mode profile by ID
   * Caches the result for subsequent calls
   */
  loadMode(modeId: string): ModeConfig {
    const modePath = join(this.modesDir, `${modeId}.yaml`);

    if (!existsSync(modePath)) {
      logger.warn('SYSTEM', `Mode file not found: ${modePath}, falling back to 'code'`);
      // If we're already trying to load 'code', throw to prevent infinite recursion
      if (modeId === 'code') {
        throw new Error('Critical: code.yaml mode file missing');
      }
      return this.loadMode('code');
    }

    try {
      const yamlContent = readFileSync(modePath, 'utf-8');
      const mode = YAML.parse(yamlContent) as ModeConfig;

      // Validate required fields
      if (!mode.name || !mode.observation_types || !mode.observation_concepts || !mode.prompts) {
        throw new Error('Invalid mode config: missing required fields');
      }

      // Validate that 'observation' type exists (universal fallback)
      const hasObservationType = mode.observation_types.some(t => t.id === 'observation');
      if (!hasObservationType) {
        throw new Error('Invalid mode config: must include "observation" type as universal fallback');
      }

      this.activeMode = mode;
      logger.debug('SYSTEM', `Loaded mode: ${mode.name} (${modeId})`, undefined, {
        types: mode.observation_types.map(t => t.id),
        concepts: mode.observation_concepts.map(c => c.id)
      });

      return mode;
    } catch (error) {
      logger.error('SYSTEM', `Failed to parse mode file: ${modePath}`, undefined, error);
      // Fallback to 'code' mode
      if (modeId === 'code') {
        throw new Error('Critical: code.yaml mode file is invalid');
      }
      return this.loadMode('code');
    }
  }

  /**
   * Get currently active mode
   */
  getActiveMode(): ModeConfig {
    if (!this.activeMode) {
      throw new Error('No mode loaded. Call loadMode() first.');
    }
    return this.activeMode;
  }

  /**
   * Get all observation types from active mode
   */
  getObservationTypes(): ObservationType[] {
    return this.getActiveMode().observation_types;
  }

  /**
   * Get all observation concepts from active mode
   */
  getObservationConcepts(): ObservationConcept[] {
    return this.getActiveMode().observation_concepts;
  }

  /**
   * Get icon for a specific observation type
   */
  getTypeIcon(typeId: string): string {
    const type = this.getObservationTypes().find(t => t.id === typeId);
    return type?.emoji || '📝';
  }

  /**
   * Get work emoji for a specific observation type
   */
  getWorkEmoji(typeId: string): string {
    const type = this.getObservationTypes().find(t => t.id === typeId);
    return type?.work_emoji || '📝';
  }

  /**
   * Validate that a type ID exists in the active mode
   */
  validateType(typeId: string): boolean {
    return this.getObservationTypes().some(t => t.id === typeId);
  }

  /**
   * Get label for a specific observation type
   */
  getTypeLabel(typeId: string): string {
    const type = this.getObservationTypes().find(t => t.id === typeId);
    return type?.label || typeId;
  }
}
