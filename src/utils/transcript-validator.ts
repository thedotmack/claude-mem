/**
 * Transcript Validation using Zod schemas
 * Adapted from claude-code-viewer for local validation
 */

import { z } from 'zod';
import { readFileSync } from 'fs';
import { logger } from './logger.js';

// ============================================================================
// Content Schemas (from claude-code-viewer)
// ============================================================================

export const TextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const ThinkingContentSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
});

export const ToolUseContentSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.any()),
});

export const ToolResultContentSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.record(z.any()))]),
  is_error: z.boolean().optional(),
});

export const ImageContentSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'),
    media_type: z.string(),
    data: z.string(),
  }),
});

// ============================================================================
// Message Schemas
// ============================================================================

const AssistantMessageContentSchema = z.union([
  ThinkingContentSchema,
  TextContentSchema,
  ToolUseContentSchema,
  ToolResultContentSchema,
]);

export const AssistantMessageSchema = z.object({
  id: z.string(),
  container: z.null().optional(),
  type: z.literal('message'),
  role: z.literal('assistant'),
  model: z.string(),
  content: z.array(AssistantMessageContentSchema),
  stop_reason: z.string().nullable(),
  stop_sequence: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation: z
      .object({
        ephemeral_5m_input_tokens: z.number(),
        ephemeral_1h_input_tokens: z.number(),
      })
      .optional(),
    output_tokens: z.number(),
    service_tier: z.string().nullable().optional(),
    server_tool_use: z
      .object({
        web_search_requests: z.number(),
      })
      .optional(),
  }),
});

const UserMessageContentSchema = z.union([
  TextContentSchema,
  ToolResultContentSchema,
  ImageContentSchema,
]);

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(UserMessageContentSchema)]),
});

// ============================================================================
// Entry Schemas
// ============================================================================

export const BaseEntrySchema = z.object({
  // required
  isSidechain: z.boolean(),
  userType: z.enum(['external']),
  cwd: z.string(),
  sessionId: z.string(),
  version: z.string(),
  uuid: z.string().uuid(),
  timestamp: z.string(),

  // nullable
  parentUuid: z.string().uuid().nullable(),

  // optional
  isMeta: z.boolean().optional(),
  toolUseResult: z.unknown().optional(),
  gitBranch: z.string().optional(),
  isCompactSummary: z.boolean().optional(),
});

export const AssistantEntrySchema = BaseEntrySchema.extend({
  // discriminator
  type: z.literal('assistant'),

  // required
  message: AssistantMessageSchema,

  // optional
  requestId: z.string().optional(),
  isApiErrorMessage: z.boolean().optional(),
});

export const UserEntrySchema = BaseEntrySchema.extend({
  type: z.literal('user'),
  message: UserMessageSchema,
  toolUseResult: z.unknown().optional(),
});

export const SummaryEntrySchema = z.object({
  type: z.literal('summary'),
  summary: z.string(),
  leafUuid: z.string(),
  cwd: z.string().optional(),
});

export const SystemEntrySchema = BaseEntrySchema.extend({
  type: z.literal('system'),
  content: z.string(),
  level: z.string().optional(),
});

export const QueueOperationEntrySchema = z.object({
  type: z.literal('queue-operation'),
  operation: z.enum(['enqueue', 'dequeue']),
  timestamp: z.string(),
  sessionId: z.string(),
  content: z.array(z.any()).optional(),
});

export const ConversationSchema = z.union([
  UserEntrySchema,
  AssistantEntrySchema,
  SummaryEntrySchema,
  SystemEntrySchema,
  QueueOperationEntrySchema,
]);

// ============================================================================
// Validation Functions
// ============================================================================

export type AssistantEntry = z.infer<typeof AssistantEntrySchema>;
export type UserEntry = z.infer<typeof UserEntrySchema>;
export type ConversationEntry = z.infer<typeof ConversationSchema>;

/**
 * Validate a single assistant entry
 */
export function validateAssistantEntry(entry: unknown): {
  success: boolean;
  data?: AssistantEntry;
  error?: z.ZodError;
} {
  try {
    const validated = AssistantEntrySchema.parse(entry);
    return { success: true, data: validated };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error };
    }
    throw error;
  }
}

/**
 * Validate any transcript entry (user, assistant, summary, etc.)
 */
export function validateTranscriptEntry(entry: unknown): {
  success: boolean;
  data?: ConversationEntry;
  error?: z.ZodError;
} {
  try {
    const validated = ConversationSchema.parse(entry);
    return { success: true, data: validated };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error };
    }
    throw error;
  }
}

/**
 * Validate an entire transcript file
 * Returns validation results for all entries
 */
export function validateTranscript(filePath: string): {
  totalLines: number;
  validLines: number;
  invalidLines: number;
  errors: Array<{
    lineNumber: number;
    error: string;
    entry?: unknown;
  }>;
} {
  const content = readFileSync(filePath, 'utf-8').trim();
  const lines = content.split('\n');

  const results = {
    totalLines: lines.length,
    validLines: 0,
    invalidLines: 0,
    errors: [] as Array<{
      lineNumber: number;
      error: string;
      entry?: unknown;
    }>,
  };

  lines.forEach((line, index) => {
    if (!line.trim()) return;

    try {
      const entry = JSON.parse(line);
      const validation = validateTranscriptEntry(entry);

      if (validation.success) {
        results.validLines++;
      } else {
        results.invalidLines++;
        results.errors.push({
          lineNumber: index + 1,
          error: validation.error?.message || 'Validation failed',
          entry,
        });
      }
    } catch (parseError) {
      results.invalidLines++;
      results.errors.push({
        lineNumber: index + 1,
        error: `JSON parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      });
    }
  });

  return results;
}

/**
 * Format validation error for logging
 */
export function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Validate and log assistant entry
 * Returns true if valid, logs error and returns false if invalid
 */
export function validateAndLogAssistantEntry(
  entry: unknown,
  context: string = 'AssistantEntry'
): entry is AssistantEntry {
  const result = validateAssistantEntry(entry);

  if (!result.success) {
    logger.error('VALIDATOR', `Invalid ${context}`, {
      errors: formatValidationError(result.error!),
      entry,
    });
    return false;
  }

  logger.debug('VALIDATOR', `Valid ${context}`, { entry });
  return true;
}
