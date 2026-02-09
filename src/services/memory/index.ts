/**
 * Memory Services Module - P0-P2 Features
 *
 * Exports all memory-related services for claude-mem.
 * Based on MemOS architecture analysis.
 *
 * Services:
 * - MemoryFeedbackService: Natural language memory correction
 * - WorkingMemoryService: Two-tier memory cache
 * - MemoryCubeService: Multi-project memory isolation
 */

export { MemoryFeedbackService, type FeedbackResult, type FeedbackDetail, type FeedbackConfig } from './MemoryFeedbackService.js';
export { WorkingMemoryService, type WorkingMemoryItem, type WorkingMemoryConfig, type SearchOptions } from './WorkingMemoryService.js';
export { MemoryCubeService, type MemoryCube, type MemoryCubeConfig, type CubeExport, type CubeMergeOptions } from './MemoryCubeService.js';
