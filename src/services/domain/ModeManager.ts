
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ModeConfig, ObservationType } from './types.js';
import { logger } from '../../utils/logger.js';
import { getPackageRoot, paths } from '../../shared/paths.js';

const MODE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

export class ModeManager {
  private static instance: ModeManager | null = null;
  private activeMode: ModeConfig | null = null;
  private activeModeId: string | null = null;
  private modeDirs: string[];

  private constructor() {
    const packageRoot = getPackageRoot();
    
    const possiblePaths = [
      ...(process.env.CLAUDE_MEM_MODES_DIR ? [process.env.CLAUDE_MEM_MODES_DIR] : []),
      join(paths.dataDir(), 'modes'),        // User-created modes (durable across plugin upgrades)
      join(packageRoot, 'modes'),           // Production (plugin/modes)
      join(packageRoot, '..', 'plugin', 'modes'), // Development (src/../plugin/modes)
    ];

    this.modeDirs = [...new Set(possiblePaths)];
  }

  static getInstance(): ModeManager {
    if (!ModeManager.instance) {
      ModeManager.instance = new ModeManager();
    }
    return ModeManager.instance;
  }

  private parseInheritance(modeId: string): {
    hasParent: boolean;
    parentId: string;
    overrideId: string;
  } {
    const parts = modeId.split('--');

    if (parts.length === 1) {
      return { hasParent: false, parentId: '', overrideId: '' };
    }

    if (parts.length > 2) {
      throw new Error(
        `Invalid mode inheritance: ${modeId}. Only one level of inheritance supported (parent--override)`
      );
    }

    return {
      hasParent: true,
      parentId: parts[0],
      overrideId: modeId 
    };
  }

  private isPlainObject(value: unknown): boolean {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    );
  }

  private deepMerge<T>(base: T, override: Partial<T>): T {
    const result = { ...base } as T;

    for (const key in override) {
      const overrideValue = override[key];
      const baseValue = base[key];

      if (this.isPlainObject(overrideValue) && this.isPlainObject(baseValue)) {
        result[key] = this.deepMerge(baseValue, overrideValue as any);
      } else {
        result[key] = overrideValue as T[Extract<keyof T, string>];
      }
    }

    return result;
  }

  private loadModeFile(modeId: string): ModeConfig {
    if (!MODE_ID_PATTERN.test(modeId)) {
      throw new Error(`Invalid mode ID: ${modeId}`);
    }

    const modePath = this.modeDirs
      .map(modesDir => join(modesDir, `${modeId}.json`))
      .find(candidate => existsSync(candidate));

    if (!modePath) {
      throw new Error(`Mode file not found: ${modeId}.json (searched: ${this.modeDirs.join(', ')})`);
    }

    const jsonContent = readFileSync(modePath, 'utf-8');
    return JSON.parse(jsonContent) as ModeConfig;
  }

  loadMode(modeId: string): ModeConfig {
    const inheritance = this.parseInheritance(modeId);

    if (!inheritance.hasParent) {
      try {
        const mode = this.loadModeFile(modeId);
        this.activeMode = mode;
        this.activeModeId = modeId;
        logger.debug('SYSTEM', `Loaded mode: ${mode.name} (${modeId})`, undefined, {
          types: mode.observation_types.map(t => t.id),
          concepts: mode.observation_concepts.map(c => c.id)
        });
        return mode;
      } catch (error) {
        if (error instanceof Error) {
          logger.warn('WORKER', `Mode file not found: ${modeId}, falling back to 'code'`, { message: error.message });
        } else {
          logger.warn('WORKER', `Mode file not found: ${modeId}, falling back to 'code'`, { error: String(error) });
        }
        if (modeId === 'code') {
          throw new Error('Critical: code.json mode file missing');
        }
        return this.loadMode('code');
      }
    }

    const { parentId, overrideId } = inheritance;

    let parentMode: ModeConfig;
    try {
      parentMode = this.loadMode(parentId);
    } catch (error) {
      if (error instanceof Error) {
        logger.warn('WORKER', `Parent mode '${parentId}' not found for ${modeId}, falling back to 'code'`, { message: error.message });
      } else {
        logger.warn('WORKER', `Parent mode '${parentId}' not found for ${modeId}, falling back to 'code'`, { error: String(error) });
      }
      parentMode = this.loadMode('code');
    }

    let overrideConfig: Partial<ModeConfig>;
    try {
      overrideConfig = this.loadModeFile(overrideId);
      logger.debug('SYSTEM', `Loaded override file: ${overrideId} for parent ${parentId}`);
    } catch (error) {
      if (error instanceof Error) {
        logger.warn('WORKER', `Override file '${overrideId}' not found, using parent mode '${parentId}' only`, { message: error.message });
      } else {
        logger.warn('WORKER', `Override file '${overrideId}' not found, using parent mode '${parentId}' only`, { error: String(error) });
      }
      this.activeMode = parentMode;
      return parentMode;
    }

    if (!overrideConfig) {
      logger.warn('SYSTEM', `Invalid override file: ${overrideId}, using parent mode '${parentId}' only`);
      this.activeMode = parentMode;
      return parentMode;
    }

    const mergedMode = this.deepMerge(parentMode, overrideConfig);
    this.activeMode = mergedMode;
    this.activeModeId = modeId;

    logger.debug('SYSTEM', `Loaded mode with inheritance: ${mergedMode.name} (${modeId} = ${parentId} + ${overrideId})`, undefined, {
      parent: parentId,
      override: overrideId,
      types: mergedMode.observation_types.map(t => t.id),
      concepts: mergedMode.observation_concepts.map(c => c.id)
    });

    return mergedMode;
  }

  getActiveMode(): ModeConfig {
    if (!this.activeMode) {
      throw new Error('No mode loaded. Call loadMode() first.');
    }
    return this.activeMode;
  }

  getActiveModeId(): string {
    if (!this.activeModeId) {
      throw new Error('No mode loaded. Call loadMode() first.');
    }
    return this.activeModeId;
  }

  getObservationTypes(): ObservationType[] {
    return this.getActiveMode().observation_types;
  }

  getTypeIcon(typeId: string): string {
    const type = this.getObservationTypes().find(t => t.id === typeId);
    return type?.emoji || '📝';
  }

  getWorkEmoji(typeId: string): string {
    const type = this.getObservationTypes().find(t => t.id === typeId);
    return type?.work_emoji || '📝';
  }
}
