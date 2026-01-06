/**
 * Timeline module re-exports
 * Provides time-based context queries for observations, sessions, and prompts
 *
 * grep-friendly: Timeline, getTimelineAroundTimestamp, getTimelineAroundObservation, getAllProjects
 */
import { logger } from '../../utils/logger.js';

export * from './timeline/queries.js';
