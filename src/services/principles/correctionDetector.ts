/**
 * Correction Detector
 * Regex-based multi-language pattern matching to detect when a user
 * is correcting Claude's behavior (e.g., "don't do X", "always use Y").
 *
 * Also detects explicit principle trigger phrases (e.g., "记住规则：...", "remember rule: ...").
 */

export interface CorrectionDetectionResult {
  isCorrection: boolean;
  patterns: string[];
  category: CorrectionCategory;
}

export type TriggerMode = 'direct' | 'reflect' | 'review';

export interface TriggerPhraseResult {
  isTriggered: boolean;
  /** The rule text extracted after the trigger keyword (only for 'direct' mode) */
  rule: string | null;
  /** How to handle the trigger: direct=store as-is, reflect=force extraction on next response, review=batch process recent corrections */
  mode: TriggerMode;
  category: CorrectionCategory;
}

export type CorrectionCategory =
  | 'behavioral'
  | 'tool_usage'
  | 'code_style'
  | 'workflow'
  | 'general';

interface PatternRule {
  pattern: RegExp;
  category: CorrectionCategory;
}

const CORRECTION_RULES: PatternRule[] = [
  // English — imperative corrections
  { pattern: /\b(no|wrong|incorrect|don't|do not|never|stop|that's not right|actually)\b/i, category: 'behavioral' },
  { pattern: /\b(should be|should have|supposed to|meant to)\b/i, category: 'behavioral' },
  { pattern: /\b(prefer|always use|always do|never use|never do)\b/i, category: 'workflow' },
  { pattern: /\b(use .+ instead|switch to|change to|replace with)\b/i, category: 'tool_usage' },
  { pattern: /\b(don't add|no comments|no docstrings|no type annotations|no tests)\b/i, category: 'code_style' },
  { pattern: /\b(remember|keep in mind|from now on|going forward)\b/i, category: 'behavioral' },

  // Chinese — corrections
  { pattern: /[不别没](要|对|是|行|可以|应该)/, category: 'behavioral' },
  { pattern: /(错了|不对|应该|不要|别用|改成|换成|记住)/, category: 'behavioral' },
  { pattern: /(永远|总是|始终|一直)(用|使用|采用)/, category: 'workflow' },
  { pattern: /(不要|别)(加|添加|写)(注释|文档|测试)/, category: 'code_style' },
  { pattern: /(用|使用|换).+(替代|代替|而不是)/, category: 'tool_usage' },
];

/**
 * Trigger phrases for 3 modes:
 *   direct  — user provides the rule text after a keyword (e.g. "记住规则：永远用bun")
 *   reflect — force model to extract principles from current conversation (e.g. "总结规则")
 *   review  — batch-process recent corrections into principles (e.g. "回顾反馈")
 */
const TRIGGER_PATTERNS: Array<{ pattern: RegExp; mode: TriggerMode; category: CorrectionCategory }> = [
  // ── Direct: capture rule text after keyword ──
  { pattern: /(?:remember\s+rule|new\s+rule|add\s+rule|#principle|#rule)\s*[:：]\s*(.+)/i, mode: 'direct', category: 'general' },
  { pattern: /(?:记住规则|新规则|添加规则|#原则|#规则)\s*[:：]\s*(.+)/, mode: 'direct', category: 'general' },

  // ── Reflect: force extraction on current session's next response ──
  { pattern: /(?:总结规则|提取教训|提取原则|#reflect)\s*$/i, mode: 'reflect', category: 'general' },
  { pattern: /\bextract\s+(?:lessons?|rules?|principles?)\s*$/i, mode: 'reflect', category: 'general' },

  // ── Review: batch-process recent corrections server-side ──
  { pattern: /(?:回顾反馈|回顾最近的?反馈|#review[-\s]?principles?)\s*$/i, mode: 'review', category: 'general' },
  { pattern: /\breview\s+(?:recent\s+)?feedback\s*$/i, mode: 'review', category: 'general' },
];

/**
 * Session-level dedup cache.
 * Key = sessionId, Value = Set of detected pattern fingerprints.
 * Prevents storing the same correction multiple times within one session.
 */
const sessionDedup = new Map<string, Set<string>>();
const SESSION_DEDUP_MAX_SESSIONS = 50;

/**
 * Detect trigger phrases for all 3 modes.
 *
 * direct:  "记住规则：永远用bun" → { isTriggered: true, mode: 'direct', rule: "永远用bun" }
 * reflect: "总结规则"            → { isTriggered: true, mode: 'reflect', rule: null }
 * review:  "回顾反馈"            → { isTriggered: true, mode: 'review',  rule: null }
 */
export function detectTriggerPhrase(userMessage: string): TriggerPhraseResult {
  if (!userMessage || userMessage.length < 2) {
    return { isTriggered: false, rule: null, mode: 'direct', category: 'general' };
  }

  const trimmed = userMessage.trim();

  for (const { pattern, mode, category } of TRIGGER_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match) {
      if (mode === 'direct') {
        // Direct mode requires captured rule text (group 1)
        const rule = match[1]?.trim();
        if (rule && rule.length >= 3) {
          return { isTriggered: true, rule, mode, category };
        }
      } else {
        // Reflect / review modes — no rule text needed
        return { isTriggered: true, rule: null, mode, category };
      }
    }
  }

  return { isTriggered: false, rule: null, mode: 'direct', category: 'general' };
}

/**
 * Detect whether a user message is a correction/feedback.
 * Returns matched patterns and an inferred category.
 */
export function detectCorrection(userMessage: string): CorrectionDetectionResult {
  if (!userMessage || userMessage.length < 3) {
    return { isCorrection: false, patterns: [], category: 'general' };
  }

  const matchedPatterns: string[] = [];
  const categoryVotes: Record<CorrectionCategory, number> = {
    behavioral: 0,
    tool_usage: 0,
    code_style: 0,
    workflow: 0,
    general: 0,
  };

  for (const rule of CORRECTION_RULES) {
    if (rule.pattern.test(userMessage)) {
      matchedPatterns.push(rule.pattern.source);
      categoryVotes[rule.category]++;
    }
  }

  if (matchedPatterns.length === 0) {
    return { isCorrection: false, patterns: [], category: 'general' };
  }

  // Pick category with most votes, default to 'general'
  let bestCategory: CorrectionCategory = 'general';
  let bestCount = 0;
  for (const [cat, count] of Object.entries(categoryVotes)) {
    if (count > bestCount) {
      bestCount = count;
      bestCategory = cat as CorrectionCategory;
    }
  }

  return {
    isCorrection: true,
    patterns: matchedPatterns,
    category: bestCategory,
  };
}

/**
 * Check session-level dedup: returns true if this correction was already
 * seen in this session (should be skipped).
 */
export function isDuplicateInSession(sessionId: string, fingerprint: string): boolean {
  const seen = sessionDedup.get(sessionId);
  if (seen?.has(fingerprint)) return true;

  // Evict oldest sessions if cache is too large
  if (!seen && sessionDedup.size >= SESSION_DEDUP_MAX_SESSIONS) {
    const oldest = sessionDedup.keys().next().value;
    if (oldest !== undefined) sessionDedup.delete(oldest);
  }

  if (!seen) sessionDedup.set(sessionId, new Set());
  sessionDedup.get(sessionId)!.add(fingerprint);
  return false;
}

/**
 * Build a fingerprint for dedup from detected patterns.
 */
export function buildCorrectionFingerprint(patterns: string[]): string {
  return patterns.sort().join('|');
}
