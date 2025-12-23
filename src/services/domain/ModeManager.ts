/**
 * ModeManager - Singleton for loading and managing mode profiles
 *
 * Mode profiles define observation types, concepts, and prompts for different use cases.
 * Default mode is 'code' (software development). Other modes like 'email-investigation'
 * can be selected via CLAUDE_MEM_MODE setting.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ModeConfig, ObservationType, ObservationConcept } from './types.js';
import { logger } from '../../utils/logger.js';
import { getPackageRoot } from '../../shared/paths.js';

export class ModeManager {
  private static instance: ModeManager | null = null;
  private activeMode: ModeConfig | null = null;
  private modesDir: string;

  private constructor() {
    // Modes are in plugin/modes/
    // getPackageRoot() points to plugin/ in production and src/ in development
    // We want to ensure we find the modes directory which is at the project root/plugin/modes
    const packageRoot = getPackageRoot();
    
    // Check for plugin/modes relative to package root (covers both dev and prod if paths are right)
    const possiblePaths = [
      join(packageRoot, 'modes'),           // Production (plugin/modes)
      join(packageRoot, '..', 'plugin', 'modes'), // Development (src/../plugin/modes)
    ];

    const foundPath = possiblePaths.find(p => existsSync(p));
    this.modesDir = foundPath || possiblePaths[0];
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
   * Parse mode ID for inheritance pattern (parent--override)
   */
  private parseInheritance(modeId: string): {
    hasParent: boolean;
    parentId: string;
    overrideId: string;
  } {
    const parts = modeId.split('--');

    if (parts.length === 1) {
      return { hasParent: false, parentId: '', overrideId: '' };
    }

    // Support only one level: code--ko, not code--ko--verbose
    if (parts.length > 2) {
      throw new Error(
        `Invalid mode inheritance: ${modeId}. Only one level of inheritance supported (parent--override)`
      );
    }

    return {
      hasParent: true,
      parentId: parts[0],
      overrideId: modeId // Use the full modeId (e.g., code--es) to find the override file
    };
  }

  /**
   * Check if value is a plain object (not array, not null)
   */
  private isPlainObject(value: unknown): boolean {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    );
  }

  /**
   * Deep merge two objects
   * - Recursively merge nested objects
   * - Replace arrays completely (no merging)
   * - Override primitives
   */
  private deepMerge<T>(base: T, override: Partial<T>): T {
    const result = { ...base } as T;

    for (const key in override) {
      const overrideValue = override[key];
      const baseValue = base[key];

      if (this.isPlainObject(overrideValue) && this.isPlainObject(baseValue)) {
        // Recursively merge nested objects
        result[key] = this.deepMerge(baseValue, overrideValue as any);
      } else {
        // Replace arrays and primitives completely
        result[key] = overrideValue as T[Extract<keyof T, string>];
      }
    }

    return result;
  }

  /**
   * Load a mode file from disk without inheritance processing
   */
  private loadModeFile(modeId: string): ModeConfig {
    const modePath = join(this.modesDir, `${modeId}.json`);

    if (!existsSync(modePath)) {
      throw new Error(`Mode file not found: ${modePath}`);
    }

    const jsonContent = readFileSync(modePath, 'utf-8');
    return JSON.parse(jsonContent) as ModeConfig;
  }

  /**
   * Load a mode profile by ID with inheritance support
   * Caches the result for subsequent calls
   *
   * Supports inheritance via parent--override pattern (e.g., code--ko)
   * - Loads parent mode recursively
   * - Loads override file from modes directory
   * - Deep merges override onto parent
   */
  loadMode(modeId: string): ModeConfig {
    const inheritance = this.parseInheritance(modeId);

    // No inheritance - load file directly (existing behavior)
    if (!inheritance.hasParent) {
      try {
        const mode = this.loadModeFile(modeId);
        this.activeMode = mode;
        logger.debug('SYSTEM', `Loaded mode: ${mode.name} (${modeId})`, undefined, {
          types: mode.observation_types.map(t => t.id),
          concepts: mode.observation_concepts.map(c => c.id)
        });
        return mode;
      } catch (error) {
        logger.warn('SYSTEM', `Mode file not found: ${modeId}, falling back to 'code'`);
        // If we're already trying to load 'code', throw to prevent infinite recursion
        if (modeId === 'code') {
          throw new Error('Critical: code.json mode file missing');
        }
        return this.loadMode('code');
      }
    }

    // Has inheritance - load parent and merge with override
    const { parentId, overrideId } = inheritance;

    // Load parent mode recursively
    let parentMode: ModeConfig;
    try {
      parentMode = this.loadMode(parentId);
    } catch (error) {
      logger.warn('SYSTEM', `Parent mode '${parentId}' not found for ${modeId}, falling back to 'code'`);
      parentMode = this.loadMode('code');
    }

    // Load override file
    let overrideConfig: Partial<ModeConfig>;
    try {
      overrideConfig = this.loadModeFile(overrideId);
      logger.debug('SYSTEM', `Loaded override file: ${overrideId} for parent ${parentId}`);
    } catch (error) {
      logger.warn('SYSTEM', `Override file '${overrideId}' not found, using parent mode '${parentId}' only`);
      this.activeMode = parentMode;
      return parentMode;
    }

    // Validate override file loaded successfully
    if (!overrideConfig) {
      logger.warn('SYSTEM', `Invalid override file: ${overrideId}, using parent mode '${parentId}' only`);
      this.activeMode = parentMode;
      return parentMode;
    }

    // Deep merge override onto parent
    const mergedMode = this.deepMerge(parentMode, overrideConfig);
    this.activeMode = mergedMode;

    logger.debug('SYSTEM', `Loaded mode with inheritance: ${mergedMode.name} (${modeId} = ${parentId} + ${overrideId})`, undefined, {
      parent: parentId,
      override: overrideId,
      types: mergedMode.observation_types.map(t => t.id),
      concepts: mergedMode.observation_concepts.map(c => c.id)
    });

    return mergedMode;
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
