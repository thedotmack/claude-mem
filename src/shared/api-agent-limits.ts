/** The deadline covers one API question and any compatibility resends. */
export interface ApiAgentLimits {
  timeoutMs: number;
  maxOutputTokens: number;
}

/** A refresh may read a whole window of conversations. Its 31 KB story answer used about 8,000
 * tokens, so the default leaves twice that room. */
export const DEFAULT_API_AGENT_LIMITS: Readonly<ApiAgentLimits> = { timeoutMs: 600_000, maxOutputTokens: 16_000 };
