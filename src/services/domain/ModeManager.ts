/**
 * ModeManager - Singleton for loading and managing mode profiles
 *
 * Mode profiles define observation types, concepts, and prompts for different use cases.
 * Default mode is 'code' (software development). Other modes like 'email-investigation'
 * can be selected per-session via CLAUDE_MEM_MODE env var.
 *
 * Supports multiple concurrent sessions with different modes by caching all loaded modes.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ModeConfig, ObservationType, ObservationConcept } from './types.js';
import { logger } from '../../utils/logger.js';
import { getPackageRoot } from '../../shared/paths.js';

export class ModeManager {
  private static instance: ModeManager | null = null;
  private modeCache: Map<string, ModeConfig> = new Map();
  private modesDir: string;

  private constructor() {
    // Modes are in plugin/modes/ - getPackageRoot() points to plugin/
    this.modesDir = join(getPackageRoot(), 'modes');
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
   * Returns cached mode if already loaded, otherwise loads from file and caches
   */
  loadMode(modeId: string): ModeConfig {
    // Check cache first
    const cached = this.modeCache.get(modeId);
    if (cached) {
      return cached;
    }

    const modePath = join(this.modesDir, `${modeId}.json`);

    if (!existsSync(modePath)) {
      logger.warn('SYSTEM', `Mode file not found: ${modePath}, falling back to 'code'`);
      // If we're already trying to load 'code', throw to prevent infinite recursion
      if (modeId === 'code') {
        throw new Error('Critical: code.json mode file missing');
      }
      return this.loadMode('code');
    }

    try {
      const jsonContent = readFileSync(modePath, 'utf-8');
      const mode = JSON.parse(jsonContent) as ModeConfig;

      // Cache the loaded mode
      this.modeCache.set(modeId, mode);
      logger.debug('SYSTEM', `Loaded mode: ${mode.name} (${modeId})`, undefined, {
        types: mode.observation_types.map(t => t.id),
        concepts: mode.observation_concepts.map(c => c.id)
      });

      return mode;
    } catch (error) {
      logger.error('SYSTEM', `Failed to load mode: ${modePath}`, undefined, error);
      if (modeId === 'code') {
        throw error; // Can't fall back from code mode
      }
      return this.loadMode('code');
    }
  }

  /**
   * Get all observation types from a mode
   */
  getObservationTypes(modeId: string): ObservationType[] {
    return this.loadMode(modeId).observation_types;
  }

  /**
   * Get all observation concepts from a mode
   */
  getObservationConcepts(modeId: string): ObservationConcept[] {
    return this.loadMode(modeId).observation_concepts;
  }

  /**
   * Get icon for a specific observation type in a mode
   */
  getTypeIcon(modeId: string, typeId: string): string {
    const type = this.getObservationTypes(modeId).find(t => t.id === typeId);
    return type?.emoji || '📝';
  }

  /**
   * Get work emoji for a specific observation type in a mode
   */
  getWorkEmoji(modeId: string, typeId: string): string {
    const type = this.getObservationTypes(modeId).find(t => t.id === typeId);
    return type?.work_emoji || '📝';
  }

  /**
   * Validate that a type ID exists in a mode
   */
  validateType(modeId: string, typeId: string): boolean {
    return this.getObservationTypes(modeId).some(t => t.id === typeId);
  }

  /**
   * Get label for a specific observation type in a mode
   */
  getTypeLabel(modeId: string, typeId: string): string {
    const type = this.getObservationTypes(modeId).find(t => t.id === typeId);
    return type?.label || typeId;
  }
}
