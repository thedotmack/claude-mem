/** Counts accept JSON numbers or decimal integer strings, without prefix parsing. */
export function parseContextCountValue(raw: unknown): number | undefined {
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    value = Number(raw.trim());
  } else {
    return undefined;
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
