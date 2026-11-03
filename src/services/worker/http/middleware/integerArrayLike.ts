import { z } from 'zod';

const integerLike = z.preprocess(
  (value) => typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : value,
  z.number().int(),
);

export const integerArrayLike = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON, fall through to comma split
    }
    return value.split(',').map((part) => Number(part.trim()));
  }
  return value;
}, z.array(integerLike));
