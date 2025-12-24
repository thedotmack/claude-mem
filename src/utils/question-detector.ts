/**
 * Question Detector
 *
 * Detects if an assistant message is asking a question that requires user input.
 * Used by the Stop hook to determine if Slack notifications should be sent.
 */

export interface QuestionDetectionResult {
  isQuestion: boolean;
  confidence: 'high' | 'medium' | 'low';
  extractedQuestion: string | null;
  reason: string;
}

/**
 * Question phrases that strongly indicate Claude is waiting for user input
 */
const QUESTION_PHRASES = [
  'would you like',
  'should i',
  'do you want',
  'shall i',
  'what do you think',
  'what would you prefer',
  'how would you like',
  'which option',
  'which approach',
  'let me know',
  'please confirm',
  'please let me know',
  'can you clarify',
  'could you clarify',
  'can you provide',
  'could you provide',
  'what is your',
  'what are your',
  'is this what you',
  'does this look',
  'does this look correct',
  'does this look right',
  'does this seem correct',
  'is that correct',
  'is this correct',
  'ready to proceed',
  'want me to',
  'like me to',
  'prefer that i',
];

/**
 * Completion phrases that indicate the task is done (not waiting for input)
 */
const COMPLETION_PHRASES = [
  'done',
  'complete',
  'completed',
  'finished',
  'successfully',
  'all set',
  'ready to use',
  'implemented',
  'created',
  'updated',
  'fixed',
  'resolved',
  'deployed',
  'committed',
  'pushed',
  'merged',
  'installed',
  'configured',
];

/**
 * Permission/tool phrases that indicate Claude Code internal prompts (NOT user questions)
 * These should NOT trigger Slack notifications - they are answered locally in the IDE
 */
const PERMISSION_PHRASES = [
  'approve the edit',
  'approve this edit',
  'approve the change',
  'approve this change',
  'permission to write',
  'permission to edit',
  'permission to modify',
  'permission to delete',
  'permission to create',
  'grant write permission',
  'grant permission',
  'need permission',
  'need your permission',
  'allow me to',
  'allow this edit',
  'allow this change',
  'can i edit',
  'can i write',
  'can i modify',
  'may i edit',
  'may i write',
  'may i modify',
];

/**
 * Extract the last sentence or question from a message
 */
function extractLastQuestion(message: string): string | null {
  // Split into sentences (handling multiple sentence-ending punctuation)
  const sentences = message.split(/(?<=[.!?])\s+/);

  // Look for the last sentence ending with ?
  for (let i = sentences.length - 1; i >= 0; i--) {
    const sentence = sentences[i].trim();
    if (sentence.endsWith('?')) {
      return sentence;
    }
  }

  // If no question mark found, check last few sentences for question phrases
  for (let i = sentences.length - 1; i >= Math.max(0, sentences.length - 3); i--) {
    const sentence = sentences[i].trim().toLowerCase();
    for (const phrase of QUESTION_PHRASES) {
      if (sentence.includes(phrase)) {
        return sentences[i].trim();
      }
    }
  }

  return null;
}

/**
 * Detect if a message is asking a question
 */
export function detectQuestion(message: string): QuestionDetectionResult {
  if (!message || message.trim().length === 0) {
    return {
      isQuestion: false,
      confidence: 'high',
      extractedQuestion: null,
      reason: 'Empty message',
    };
  }

  const normalizedMessage = message.toLowerCase();

  // Check for permission phrases FIRST - these are Claude Code internal prompts
  // that should NOT trigger Slack notifications
  for (const phrase of PERMISSION_PHRASES) {
    if (normalizedMessage.includes(phrase)) {
      return {
        isQuestion: false,
        confidence: 'high',
        extractedQuestion: null,
        reason: `Permission/tool prompt detected: "${phrase}" - should be answered locally`,
      };
    }
  }

  // Check for completion indicators first
  const lastParagraph = message.split('\n\n').pop() || message;
  const normalizedLastParagraph = lastParagraph.toLowerCase();

  // Count completion phrases in last paragraph
  let completionScore = 0;
  for (const phrase of COMPLETION_PHRASES) {
    if (normalizedLastParagraph.includes(phrase)) {
      completionScore++;
    }
  }

  // Check for question indicators
  let questionScore = 0;
  const extractedQuestion = extractLastQuestion(message);

  // Strong indicator: message ends with question mark
  if (message.trim().endsWith('?')) {
    questionScore += 3;
  }

  // Check for question phrases
  for (const phrase of QUESTION_PHRASES) {
    if (normalizedMessage.includes(phrase)) {
      questionScore++;
    }
  }

  // Decision logic
  if (questionScore >= 3 && completionScore === 0) {
    return {
      isQuestion: true,
      confidence: 'high',
      extractedQuestion,
      reason: 'Message ends with question mark and contains question phrases',
    };
  }

  if (questionScore >= 2 && completionScore <= 1) {
    return {
      isQuestion: true,
      confidence: 'medium',
      extractedQuestion,
      reason: 'Message contains multiple question indicators',
    };
  }

  if (questionScore >= 1 && completionScore === 0) {
    return {
      isQuestion: true,
      confidence: 'low',
      extractedQuestion,
      reason: 'Message contains question indicator without completion phrases',
    };
  }

  if (completionScore >= 2) {
    return {
      isQuestion: false,
      confidence: 'high',
      extractedQuestion: null,
      reason: 'Message contains completion phrases indicating task is done',
    };
  }

  return {
    isQuestion: false,
    confidence: 'medium',
    extractedQuestion: null,
    reason: 'No clear question indicators found',
  };
}

/**
 * Simple check if message likely contains a question (for quick filtering)
 */
export function mightBeQuestion(message: string): boolean {
  if (!message) return false;

  const normalized = message.toLowerCase();

  // Quick exclusion: permission/tool prompts should NOT go to Slack
  for (const phrase of PERMISSION_PHRASES.slice(0, 5)) {
    if (normalized.includes(phrase)) return false;
  }

  // Quick checks for questions
  if (message.trim().endsWith('?')) return true;

  for (const phrase of QUESTION_PHRASES.slice(0, 10)) {
    if (normalized.includes(phrase)) return true;
  }

  return false;
}
