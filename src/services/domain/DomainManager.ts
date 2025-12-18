/**
 * DomainManager - Singleton for loading and managing domain profiles
 *
 * Domain profiles define observation types, concepts, and prompts for different use cases.
 * Default domain is 'code' (software development). Other domains like 'email-investigation'
 * can be selected via CLAUDE_MEM_DOMAIN setting.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';
import type { DomainConfig, ObservationType, ObservationConcept } from './types.js';
import { logger } from '../../utils/logger.js';
import { DATA_DIR } from '../../shared/paths.js';

export class DomainManager {
  private static instance: DomainManager | null = null;
  private activeDomain: DomainConfig | null = null;
  private domainsDir: string;

  private constructor() {
    this.domainsDir = join(DATA_DIR, 'domains');
  }

  /**
   * Get singleton instance
   */
  static getInstance(): DomainManager {
    if (!DomainManager.instance) {
      DomainManager.instance = new DomainManager();
    }
    return DomainManager.instance;
  }

  /**
   * Load a domain profile by ID
   * Caches the result for subsequent calls
   */
  loadDomain(domainId: string): DomainConfig {
    const domainPath = join(this.domainsDir, `${domainId}.yaml`);

    if (!existsSync(domainPath)) {
      logger.warn('SYSTEM', `Domain file not found: ${domainPath}, falling back to 'code'`);
      // If we're already trying to load 'code', throw to prevent infinite recursion
      if (domainId === 'code') {
        throw new Error('Critical: code.yaml domain file missing');
      }
      return this.loadDomain('code');
    }

    try {
      const yamlContent = readFileSync(domainPath, 'utf-8');
      const domain = YAML.parse(yamlContent) as DomainConfig;

      // Validate required fields
      if (!domain.name || !domain.observation_types || !domain.observation_concepts || !domain.prompts) {
        throw new Error('Invalid domain config: missing required fields');
      }

      // Validate that 'observation' type exists (universal fallback)
      const hasObservationType = domain.observation_types.some(t => t.id === 'observation');
      if (!hasObservationType) {
        throw new Error('Invalid domain config: must include "observation" type as universal fallback');
      }

      this.activeDomain = domain;
      logger.debug('SYSTEM', `Loaded domain: ${domain.name} (${domainId})`, undefined, {
        types: domain.observation_types.map(t => t.id),
        concepts: domain.observation_concepts.map(c => c.id)
      });

      return domain;
    } catch (error) {
      logger.error('SYSTEM', `Failed to parse domain file: ${domainPath}`, undefined, error);
      // Fallback to 'code' domain
      if (domainId === 'code') {
        throw new Error('Critical: code.yaml domain file is invalid');
      }
      return this.loadDomain('code');
    }
  }

  /**
   * Get currently active domain
   */
  getActiveDomain(): DomainConfig {
    if (!this.activeDomain) {
      throw new Error('No domain loaded. Call loadDomain() first.');
    }
    return this.activeDomain;
  }

  /**
   * Get all observation types from active domain
   */
  getObservationTypes(): ObservationType[] {
    return this.getActiveDomain().observation_types;
  }

  /**
   * Get all observation concepts from active domain
   */
  getObservationConcepts(): ObservationConcept[] {
    return this.getActiveDomain().observation_concepts;
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
   * Validate that a type ID exists in the active domain
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
