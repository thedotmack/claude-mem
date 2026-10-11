// SPDX-License-Identifier: Apache-2.0

export function parseOpenRouterTemperature(raw: unknown): number | undefined {
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 2 ? value : undefined;
}
