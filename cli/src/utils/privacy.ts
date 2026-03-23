/**
 * Privacy tag stripping — defense-in-depth.
 * The worker already strips <private> tags at the hook layer,
 * but we add a second pass before outputting to terminal.
 */

const PRIVATE_TAG_PATTERN = /<private>[\s\S]*?<\/private>/gi;

export function stripPrivateTags(text: string): string {
  return text.replace(PRIVATE_TAG_PATTERN, '[REDACTED]');
}

export function hasPrivateTags(text: string): boolean {
  // Fresh regex per call — avoids stateful lastIndex from /g flag
  return /<private>[\s\S]*?<\/private>/i.test(text);
}
