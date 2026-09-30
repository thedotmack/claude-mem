// SPDX-License-Identifier: Apache-2.0

import { logger } from '../../utils/logger.js';

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('DB', 'Failed to parse stored JSON object column; using empty object', { value }, err);
    return {};
  }
}

export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('DB', 'Failed to parse stored JSON array column; using empty array', { value }, err);
    return [];
  }
}
