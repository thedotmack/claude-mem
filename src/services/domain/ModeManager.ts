
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

  /**
   * Split a mode ID into its parent and the override files layered on it, in
   * order. Each `--` segment names one `parent--segment` file, so
   * `code--chill--ko` loads code.json, then code--chill.json, then
   * code--ko.json. Overrides never stack on each other's IDs: every file ID
   * this returns is a single `parent--override` pair.
   */
  private parseInheritance(modeId: string): {
    parentId: string;
    overrideIds: string[];
  } {
    const [parentId, ...segments] = modeId.split('--');
    return {
      parentId,
      overrideIds: segments.map(segment => `${parentId}--${segment}`),
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
      const { parentId, overrideIds } = this.parseInheritance(modeId);
      if (overrideIds.length > 0) {
        const parent = this.loadModeFile(parentId);
        const overrides = overrideIds.map(overrideId => this.loadModeFile(overrideId));
        const modePaths = [parent.path, ...overrides.map(override => override.path)];
        if (![parent, ...overrides].every(file => this.isPlainObject(file.mode))) {
          throw new InvalidModeError(`Invalid mode (${modePaths.join(', ')}): parent and override must be JSON objects`);
        }
        mode = overrides.reduce((merged, override) => this.deepMerge(merged, override.mode), parent.mode);
        this.validateMode(mode, modePaths);
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

  useModeSnapshot(mode: ModeConfig): void {
    this.validateMode(mode, ['context reader snapshot']);
    if (!mode.id) throw new Error('Context mode snapshot requires an id');
    this.activeMode = mode;
    this.activeModeId = mode.id;
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
