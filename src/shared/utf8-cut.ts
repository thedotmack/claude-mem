/**
 * Where to cut UTF-8 `bytes` at or before `index` without splitting a
 * character: back over continuation bytes (10xxxxxx) to the character's
 * first byte. An index at or past the end is returned as it is.
 */
export function utf8CutIndex(bytes: Uint8Array, index: number): number {
  let end = index;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return end;
}
