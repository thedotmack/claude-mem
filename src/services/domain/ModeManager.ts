
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import type { ModeConfig, ObservationType } from './types.js';
import { logger } from '../../utils/logger.js';
import { getPackageRoot, paths } from '../../shared/paths.js';
import { validateMode } from './mode-validation.js';

const MODE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

class InvalidModeError extends Error {}

export class ModeManager {
  private static instance: ModeManager | null = null;
  private activeMode: ModeConfig | null = null;
  private activeModeId: string | null = null;
  private bundledModeDirs: string[];
  private userModesDir: string;
  private overrideModesDir: string | undefined;

  private constructor() {
    const packageRoot = getPackageRoot();
    
    this.overrideModesDir = process.env.CLAUDE_MEM_MODES_DIR;
    this.userModesDir = join(paths.dataDir(), 'modes');
    this.bundledModeDirs = [...new Set([
      join(packageRoot, 'modes'),           // Production (plugin/modes)
      join(packageRoot, '..', 'plugin', 'modes'), // Development (src/../plugin/modes)
    ])];
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

  private loadModeFile(modeId: string, bundledOnly: boolean = false): { mode: ModeConfig; path: string } {
    if (!MODE_ID_PATTERN.test(modeId)) {
      throw new Error(`Invalid mode ID: ${modeId}`);
    }

    const bundledPath = this.bundledModeDirs
      .map(modesDir => join(modesDir, `${modeId}.json`))
      .find(candidate => existsSync(candidate));
    const isBundled = modeId === 'code' || !!bundledPath;
    const userPath = join(this.userModesDir, `${modeId}.json`);
    const explicitlySelectedUserDir = this.overrideModesDir && resolve(this.overrideModesDir) === resolve(this.userModesDir);
    if (isBundled && existsSync(userPath) && (bundledOnly || !explicitlySelectedUserDir)) {
      logger.error('SYSTEM', `Ignoring user mode file ${userPath}: bundled mode '${modeId}' cannot be shadowed. Use a ${modeId.split('--')[0]}--<name> override instead.`);
    }

    const modeDirs = bundledOnly ? this.bundledModeDirs : [
      ...(this.overrideModesDir ? [this.overrideModesDir] : []),
      ...(!isBundled ? [this.userModesDir] : []),
      ...this.bundledModeDirs,
    ];
    const modePath = modeDirs
      .map(modesDir => join(modesDir, `${modeId}.json`))
      .find(candidate => existsSync(candidate));

    if (!modePath) {
      throw new Error(`Mode file not found: ${modeId}.json (searched: ${modeDirs.join(', ')})`);
    }

    try {
      const jsonContent = readFileSync(modePath, 'utf-8');
      return { mode: JSON.parse(jsonContent), path: modePath };
    } catch (error) {
      throw new InvalidModeError(`Could not load mode file ${modePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private validateMode(mode: ModeConfig, modePaths: string[]): void {
    const missing = validateMode(mode);
    if (missing.length > 0) {
      throw new InvalidModeError(`Invalid mode (${modePaths.join(', ')}): missing or invalid keys: ${missing.join(', ')}`);
    }
  }

  loadMode(modeId: string): ModeConfig {
    let mode: ModeConfig;
    try {
      const inheritance = this.parseInheritance(modeId);
      if (inheritance.hasParent) {
        const parent = this.loadModeFile(inheritance.parentId);
        const override = this.loadModeFile(inheritance.overrideId);
        if (!this.isPlainObject(parent.mode) || !this.isPlainObject(override.mode)) {
          throw new InvalidModeError(`Invalid mode (${parent.path}, ${override.path}): parent and override must be JSON objects`);
        }
        mode = this.deepMerge(parent.mode, override.mode);
        this.validateMode(mode, [parent.path, override.path]);
      } else {
        const loaded = this.loadModeFile(modeId);
        mode = loaded.mode;
        this.validateMode(mode, [loaded.path]);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof InvalidModeError) {
        logger.error('WORKER', `Failed to load mode '${modeId}': ${reason}`);
        throw error;
      }
      logger.error('WORKER', `Failed to load mode '${modeId}': ${reason}; falling back to bundled 'code'`);
      try {
        const fallback = this.loadModeFile('code', true);
        this.validateMode(fallback.mode, [fallback.path]);
        mode = fallback.mode;
        modeId = 'code';
      } catch (fallbackError) {
        const message = `Critical: could not load bundled 'code' mode: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
        logger.error('WORKER', message);
        throw new Error(message);
      }
    }

    mode.id = modeId;
    this.activeMode = mode;
    this.activeModeId = modeId;
    logger.debug('SYSTEM', `Loaded mode: ${mode.name} (${modeId})`, undefined, {
      types: mode.observation_types.map(t => t.id),
      concepts: mode.observation_concepts.map(c => c.id)
    });
    return mode;
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
