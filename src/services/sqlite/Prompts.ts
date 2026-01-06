/**
 * User prompts module - named re-exports
 *
 * Provides all user prompt database operations as standalone functions.
 * Each function takes `db: Database` as first parameter.
 */
import { logger } from '../../utils/logger.js';

export * from './prompts/types.js';
export * from './prompts/store.js';
export * from './prompts/get.js';
