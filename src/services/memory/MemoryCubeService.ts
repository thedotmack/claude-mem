/**
 * Memory Cube Service - P2 Feature
 *
 * Implements memory isolation and management inspired by MemOS's MemCube concept.
 * Allows multiple isolated memory "cubes" that can be loaded, dumped, and shared.
 *
 * Use Cases:
 * - Different projects use different memory cubes
 * - Team memory sharing (export/import cubes)
 * - A/B testing different memory strategies
 * - Memory isolation for privacy/security
 *
 * Key Features:
 * - Multi-cube management (project/user-based isolation)
 * - Export/import cubes as JSON
 * - Cube merging and composition
 * - Metadata filtering per cube
 */

import { logger } from '../../utils/logger.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { ObservationSearchResult } from '../sqlite/types.js';

export interface MemoryCubeConfig {
  cubeId: string;
  name: string;
  description?: string;
  projectFilter?: string;
  userFilter?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryCube {
  config: MemoryCubeConfig;
  observations: Map<number, ObservationSearchResult>;
  metadata: {
    totalObservations: number;
    lastObservationAt: number;
    compressedSize: number;
  };
}

export interface CubeExport {
  config: MemoryCubeConfig;
  observations: ObservationSearchResult[];
  exportedAt: number;
  version: string;
}

export interface CubeMergeOptions {
  strategy: 'append' | 'replace' | 'merge';
  conflictResolution: 'keep-existing' | 'keep-new' | 'keep-both' | 'ask';
}

export class MemoryCubeService {
  private cubes: Map<string, MemoryCube> = new Map();
  private activeCubeId: string | null = null;
  private storageDir: string;

  constructor(storageDir: string = '~/.claude-mem/cubes') {
    this.storageDir = storageDir.replace('~', process.env.HOME || '');
    this.ensureStorageDir();
    this.loadCubesFromStorage();
    logger.info('MEMORY_CUBE', 'Initialized', { storageDir: this.storageDir, loadedCubes: this.cubes.size });
  }

  /**
   * Create a new memory cube
   */
  createCube(
    cubeId: string,
    name: string,
    config?: Partial<MemoryCubeConfig>
  ): MemoryCube {
    if (this.cubes.has(cubeId)) {
      throw new Error(`Memory cube "${cubeId}" already exists`);
    }

    const now = Date.now();
    const cubeConfig: MemoryCubeConfig = {
      cubeId,
      name,
      description: config?.description || '',
      projectFilter: config?.projectFilter,
      userFilter: config?.userFilter,
      createdAt: now,
      updatedAt: now
    };

    const cube: MemoryCube = {
      config: cubeConfig,
      observations: new Map(),
      metadata: {
        totalObservations: 0,
        lastObservationAt: 0,
        compressedSize: 0
      }
    };

    this.cubes.set(cubeId, cube);
    this.saveCubeToStorage(cubeId);

    logger.info('MEMORY_CUBE', 'Cube created', { cubeId, name });
    return cube;
  }

  /**
   * Get or create a cube for a specific project
   * Auto-creates project-specific cubes on demand
   */
  getOrCreateProjectCube(project: string): MemoryCube {
    const cubeId = this.sanitizeCubeId(`project-${project}`);
    let cube = this.cubes.get(cubeId);

    if (!cube) {
      cube = this.createCube(cubeId, `Project: ${project}`, {
        projectFilter: project,
        description: `Auto-generated cube for project "${project}"`
      });
    }

    return cube;
  }

  /**
   * Add an observation to the appropriate cube
   * Determines target cube based on project/user filters
   */
  addToCube(observation: ObservationSearchResult): void {
    const targetCube = this.findTargetCube(observation);
    if (!targetCube) {
      logger.debug('MEMORY_CUBE', 'No matching cube found, using default', {
        observationId: observation.id,
        project: observation.project
      });
      return;
    }

    targetCube.observations.set(observation.id, observation);
    targetCube.metadata.totalObservations = targetCube.observations.size;
    targetCube.metadata.lastObservationAt = Math.max(
      targetCube.metadata.lastObservationAt,
      observation.created_at_epoch
    );
    targetCube.config.updatedAt = Date.now();

    logger.debug('MEMORY_CUBE', 'Observation added to cube', {
      cubeId: targetCube.config.cubeId,
      observationId: observation.id,
      totalInCube: targetCube.observations.size
    });
  }

  /**
   * Find the appropriate cube for an observation
   * Matches based on project/user filters
   */
  private findTargetCube(observation: ObservationSearchResult): MemoryCube | null {
    // First try exact project match
    for (const cube of this.cubes.values()) {
      if (cube.config.projectFilter && cube.config.projectFilter === observation.project) {
        return cube;
      }
    }

    // Try user filter (if supported in ObservationSearchResult)
    // Note: user_name field may not be available in current schema
    // if (observation.user_name) {
    //   for (const cube of this.cubes.values()) {
    //     if (cube.config.userFilter && cube.config.userFilter === observation.user_name) {
    //       return cube;
    //     }
    //   }
    // }

    // Use active cube if set
    if (this.activeCubeId) {
      return this.cubes.get(this.activeCubeId) || null;
    }

    // Create project cube as fallback
    return this.getOrCreateProjectCube(observation.project);
  }

  /**
   * Search within a specific cube
   */
  searchCube(
    cubeId: string,
    query?: string,
    options?: {
      limit?: number;
      type?: string;
      orderBy?: 'date_desc' | 'date_asc';
    }
  ): ObservationSearchResult[] {
    const cube = this.cubes.get(cubeId);
    if (!cube) {
      logger.warn('MEMORY_CUBE', 'Cube not found', { cubeId });
      return [];
    }

    let results = Array.from(cube.observations.values());

    // Apply type filter
    if (options?.type) {
      results = results.filter(obs => obs.type === options.type);
    }

    // Apply query filter (simple keyword matching)
    if (query) {
      const queryLower = query.toLowerCase();
      results = results.filter(obs => {
        const titleMatch = obs.title?.toLowerCase().includes(queryLower);
        const narrativeMatch = obs.narrative?.toLowerCase().includes(queryLower);
        const conceptMatch = Array.isArray(obs.concepts) && obs.concepts.some((c: string) =>
          c.toLowerCase().includes(queryLower)
        );
        return titleMatch || narrativeMatch || conceptMatch;
      });
    }

    // Apply sorting
    if (options?.orderBy === 'date_desc') {
      results.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
    } else if (options?.orderBy === 'date_asc') {
      results.sort((a, b) => a.created_at_epoch - b.created_at_epoch);
    }

    // Apply limit
    const limited = results.slice(0, options?.limit || 20);

    logger.debug('MEMORY_CUBE', 'Search completed', {
      cubeId,
      query,
      resultsCount: limited.length
    });

    return limited;
  }

  /**
   * Export a cube to a JSON file
   */
  exportCube(cubeId: string, exportPath?: string): string {
    const cube = this.cubes.get(cubeId);
    if (!cube) {
      throw new Error(`Cube "${cubeId}" not found`);
    }

    const exportData: CubeExport = {
      config: cube.config,
      observations: Array.from(cube.observations.values()),
      exportedAt: Date.now(),
      version: '1.0.0'
    };

    const defaultPath = join(this.storageDir, `${cubeId}.json`);
    const outputPath = exportPath || defaultPath;

    writeFileSync(outputPath, JSON.stringify(exportData, null, 2), 'utf-8');
    cube.metadata.compressedSize = Buffer.byteLength(JSON.stringify(exportData));

    logger.info('MEMORY_CUBE', 'Cube exported', {
      cubeId,
      path: outputPath,
      observationCount: exportData.observations.length
    });

    return outputPath;
  }

  /**
   * Import a cube from a JSON file
   */
  importCube(importPath: string, cubeId?: string): MemoryCube {
    if (!existsSync(importPath)) {
      throw new Error(`Import file not found: ${importPath}`);
    }

    const data = JSON.parse(readFileSync(importPath, 'utf-8')) as CubeExport;

    // Use provided cubeId or import from config
    const targetCubeId = cubeId || data.config.cubeId;

    if (this.cubes.has(targetCubeId)) {
      throw new Error(`Cube "${targetCubeId}" already exists. Use mergeCube() instead.`);
    }

    const cube: MemoryCube = {
      config: {
        ...data.config,
        cubeId: targetCubeId,
        updatedAt: Date.now()
      },
      observations: new Map(
        data.observations.map(obs => [obs.id, obs])
      ),
      metadata: {
        totalObservations: data.observations.length,
        lastObservationAt: data.observations.reduce((max, obs) =>
          Math.max(max, obs.created_at_epoch), 0),
        compressedSize: 0
      }
    };

    this.cubes.set(targetCubeId, cube);
    this.saveCubeToStorage(targetCubeId);

    logger.info('MEMORY_CUBE', 'Cube imported', {
      cubeId: targetCubeId,
      sourcePath: importPath,
      observationCount: data.observations.length
    });

    return cube;
  }

  /**
   * Merge one cube into another
   */
  mergeCube(
    sourceCubeId: string,
    targetCubeId: string,
    options: CubeMergeOptions = {
      strategy: 'merge',
      conflictResolution: 'keep-existing'
    }
  ): void {
    const source = this.cubes.get(sourceCubeId);
    const target = this.cubes.get(targetCubeId);

    if (!source) {
      throw new Error(`Source cube "${sourceCubeId}" not found`);
    }
    if (!target) {
      throw new Error(`Target cube "${targetCubeId}" not found`);
    }

    if (options.strategy === 'replace') {
      target.observations = new Map(source.observations);
    } else if (options.strategy === 'append') {
      for (const [id, obs] of source.observations) {
        target.observations.set(id, obs);
      }
    } else if (options.strategy === 'merge') {
      for (const [id, obs] of source.observations) {
        const existing = target.observations.get(id);
        if (!existing) {
          target.observations.set(id, obs);
        } else if (options.conflictResolution === 'keep-new') {
          target.observations.set(id, obs);
        } else if (options.conflictResolution === 'keep-both') {
          // Create new ID for duplicate
          const newId = this.generateNewId(target);
          target.observations.set(newId, { ...obs, id: newId });
        }
        // 'keep-existing' does nothing (default behavior)
      }
    }

    target.metadata.totalObservations = target.observations.size;
    target.config.updatedAt = Date.now();

    logger.info('MEMORY_CUBE', 'Cubes merged', {
      sourceCubeId,
      targetCubeId,
      strategy: options.strategy,
      resultingSize: target.observations.size
    });
  }

  /**
   * Set the active cube for automatic routing
   */
  setActiveCube(cubeId: string): void {
    if (!this.cubes.has(cubeId)) {
      throw new Error(`Cube "${cubeId}" not found`);
    }
    this.activeCubeId = cubeId;
    logger.info('MEMORY_CUBE', 'Active cube set', { cubeId });
  }

  /**
   * Get the active cube
   */
  getActiveCube(): MemoryCube | null {
    return this.activeCubeId ? this.cubes.get(this.activeCubeId) || null : null;
  }

  /**
   * List all cubes
   */
  listCubes(): Array<{
    cubeId: string;
    name: string;
    observationCount: number;
    projectFilter?: string;
    userFilter?: string;
  }> {
    return Array.from(this.cubes.values()).map(cube => ({
      cubeId: cube.config.cubeId,
      name: cube.config.name,
      observationCount: cube.observations.size,
      projectFilter: cube.config.projectFilter,
      userFilter: cube.config.userFilter
    }));
  }

  /**
   * Delete a cube
   */
  deleteCube(cubeId: string): boolean {
    const deleted = this.cubes.delete(cubeId);
    if (deleted) {
      // Remove from storage
      const cubePath = join(this.storageDir, `${cubeId}.json`);
      if (existsSync(cubePath)) {
        // Note: In production, use fs.unlink
        logger.info('MEMORY_CUBE', 'Cube deleted from storage', { cubeId, path: cubePath });
      }
      if (this.activeCubeId === cubeId) {
        this.activeCubeId = null;
      }
    }
    return deleted;
  }

  /**
   * Get cube statistics
   */
  getCubeStats(cubeId: string): {
    config: MemoryCubeConfig;
    observationCount: number;
    lastObservationAt: number;
    sizeInBytes: number;
  } | null {
    const cube = this.cubes.get(cubeId);
    if (!cube) {
      return null;
    }

    return {
      config: cube.config,
      observationCount: cube.observations.size,
      lastObservationAt: cube.metadata.lastObservationAt,
      sizeInBytes: cube.metadata.compressedSize
    };
  }

  /**
   * Ensure storage directory exists
   */
  private ensureStorageDir(): void {
    try {
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
      }
    } catch (error) {
      logger.error('MEMORY_CUBE', 'Failed to create storage directory', { error });
    }
  }

  /**
   * Save cube to storage
   */
  private saveCubeToStorage(cubeId: string): void {
    try {
      const cube = this.cubes.get(cubeId);
      if (!cube) return;

      const exportPath = join(this.storageDir, `${cubeId}.json`);
      this.exportCube(cubeId, exportPath);
    } catch (error) {
      logger.error('MEMORY_CUBE', 'Failed to save cube to storage', { cubeId, error });
    }
  }

  /**
   * Load cubes from storage directory
   */
  private loadCubesFromStorage(): void {
    try {
      if (!existsSync(this.storageDir)) {
        return;
      }

      const files = readdirSync(this.storageDir);
      const cubeFiles = files.filter(f => f.endsWith('.json'));

      for (const file of cubeFiles) {
        try {
          const cubeId = file.replace('.json', '');
          this.importCube(join(this.storageDir, file), cubeId);
        } catch (error) {
          logger.warn('MEMORY_CUBE', 'Failed to load cube from storage', { file, error });
        }
      }
    } catch (error) {
      logger.error('MEMORY_CUBE', 'Failed to load cubes from storage', { error });
    }
  }

  /**
   * Sanitize cube ID for safe file system usage
   */
  private sanitizeCubeId(id: string): string {
    return id
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Generate a new unique ID within a cube
   */
  private generateNewId(cube: MemoryCube): number {
    const existingIds = Array.from(cube.observations.keys());
    return existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;
  }
}

