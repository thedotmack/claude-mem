/**
 * Token-level F1 scoring module for LoCoMo QA evaluation.
 *
 * Normalization pipeline matches the original LoCoMo evaluation code
 * (task_eval/evaluation.py) for fair baseline comparison:
 *   1. Remove commas
 *   2. Lowercase
 *   3. Remove punctuation
 *   4. Remove articles: "a", "an", "the", "and" (LoCoMo includes "and")
 *   5. Collapse whitespace
 *
 * Stemming uses a minimal Porter stemmer (Step 1a/1b/1c) matching
 * NLTK's PorterStemmer used in the original Python implementation.
 */

// ---------------------------------------------------------------------------
// Normalization (matches LoCoMo evaluation.py normalize_answer)
// ---------------------------------------------------------------------------

export function normalizeAnswer(text: string): string {
  let s = text;
  // Step 0: Remove commas (LoCoMo does this before other normalization)
  s = s.replace(/,/g, "");
  // Step 1: Lowercase
  s = s.toLowerCase();
  // Step 2: Remove punctuation (keep alphanumeric and spaces)
  s = s.replace(/[^\w\s]|_/g, "");
  // Step 3: Remove articles — LoCoMo removes "a", "an", "the", AND "and"
  s = s.replace(/\b(a|an|the|and)\b/g, " ");
  // Step 4: Collapse whitespace and trim
  s = s.split(/\s+/).filter(Boolean).join(" ");
  return s;
}

// ---------------------------------------------------------------------------
// Minimal Porter Stemmer (Step 1a, 1b, 1c)
// ---------------------------------------------------------------------------

/** Count vowel-consonant sequences (the "measure" m) in a word. */
function measure(word: string): number {
  // A vowel is a, e, i, o, u, or y preceded by a consonant
  const vowelPattern = /[aeiouy]/;
  let m = 0;
  let inVowelSeq = false;
  for (let i = 0; i < word.length; i++) {
    const isVowel = vowelPattern.test(word[i]) && !(word[i] === "y" && i === 0);
    if (isVowel && !inVowelSeq) {
      inVowelSeq = true;
    } else if (!isVowel && inVowelSeq) {
      m++;
      inVowelSeq = false;
    }
  }
  return m;
}

/** Check if stem contains a vowel. */
function hasVowel(word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (/[aeiou]/.test(ch)) return true;
    if (ch === "y" && i > 0) return true;
  }
  return false;
}

/** Check if word ends with a double consonant. */
function endsWithDoubleConsonant(word: string): boolean {
  if (word.length < 2) return false;
  const last = word[word.length - 1];
  const prev = word[word.length - 2];
  if (last !== prev) return false;
  return !/[aeiou]/.test(last);
}

/** Check if word ends with consonant-vowel-consonant where last C is not w/x/y. */
function endsWithCVC(word: string): boolean {
  if (word.length < 3) return false;
  const c2 = word[word.length - 1];
  const v = word[word.length - 2];
  const c1 = word[word.length - 3];
  if (/[wxy]/.test(c2)) return false;
  const isC2Consonant = !/[aeiou]/.test(c2) && !(c2 === "y" && word.length - 1 > 0);
  const isVVowel = /[aeiou]/.test(v) || (v === "y" && word.length - 2 > 0);
  const isC1Consonant = !/[aeiou]/.test(c1) && !(c1 === "y" && word.length - 3 === 0);
  return isC1Consonant && isVVowel && isC2Consonant;
}

/**
 * Minimal Porter stemmer implementing Steps 1a, 1b, and 1c.
 * Handles plurals (-s, -es, -ies), past tense (-ed), gerunds (-ing),
 * and -ness suffix.
 */
export function porterStem(word: string): string {
  if (word.length <= 2) return word;

  // Step 1a: plurals
  if (word.endsWith("sses")) {
    word = word.slice(0, -2); // sses → ss
  } else if (word.endsWith("ies")) {
    word = word.slice(0, -2); // ies → i
  } else if (word.endsWith("ss")) {
    // keep as-is
  } else if (word.endsWith("s")) {
    word = word.slice(0, -1); // s → (remove)
  }

  // Step 1b: -eed, -ed, -ing
  if (word.endsWith("eed")) {
    const stem = word.slice(0, -3);
    if (measure(stem) > 0) {
      word = word.slice(0, -1); // eed → ee
    }
  } else if (word.endsWith("ed")) {
    const stem = word.slice(0, -2);
    if (hasVowel(stem)) {
      word = stem;
      // Post-processing after -ed removal
      if (word.endsWith("at") || word.endsWith("bl") || word.endsWith("iz")) {
        word += "e";
      } else if (endsWithDoubleConsonant(word) && !/[lsz]/.test(word[word.length - 1])) {
        word = word.slice(0, -1);
      } else if (measure(word) === 1 && endsWithCVC(word)) {
        word += "e";
      }
    }
  } else if (word.endsWith("ing")) {
    const stem = word.slice(0, -3);
    if (hasVowel(stem)) {
      word = stem;
      // Same post-processing as -ed
      if (word.endsWith("at") || word.endsWith("bl") || word.endsWith("iz")) {
        word += "e";
      } else if (endsWithDoubleConsonant(word) && !/[lsz]/.test(word[word.length - 1])) {
        word = word.slice(0, -1);
      } else if (measure(word) === 1 && endsWithCVC(word)) {
        word += "e";
      }
    }
  }

  // Step 1c: y → i when stem has vowel
  if (word.endsWith("y")) {
    const stem = word.slice(0, -1);
    if (hasVowel(stem)) {
      word = stem + "i";
    }
  }

  // Bonus: handle -ness (common in QA answers)
  if (word.endsWith("ness")) {
    const stem = word.slice(0, -4);
    if (measure(stem) > 0) {
      word = stem;
    }
  }

  return word;
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

export function tokenize(normalizedText: string): string[] {
  if (!normalizedText) return [];
  return normalizedText.split(/\s+/).filter(Boolean).map(porterStem);
}

// ---------------------------------------------------------------------------
// Token-level F1
// ---------------------------------------------------------------------------

export function computeTokenF1(predicted: string, groundTruth: string): number {
  const normalizedPredicted = normalizeAnswer(predicted);
  const normalizedGroundTruth = normalizeAnswer(groundTruth);

  // Special case: both empty after normalization
  if (!normalizedPredicted && !normalizedGroundTruth) return 1.0;

  const predictedTokens = tokenize(normalizedPredicted);
  const groundTruthTokens = tokenize(normalizedGroundTruth);

  if (predictedTokens.length === 0 && groundTruthTokens.length === 0) return 1.0;
  if (predictedTokens.length === 0 || groundTruthTokens.length === 0) return 0.0;

  // Multiset intersection using Counter-style approach (matches Python Counter &)
  const predictedCounts = new Map<string, number>();
  for (const token of predictedTokens) {
    predictedCounts.set(token, (predictedCounts.get(token) ?? 0) + 1);
  }

  const groundTruthCounts = new Map<string, number>();
  for (const token of groundTruthTokens) {
    groundTruthCounts.set(token, (groundTruthCounts.get(token) ?? 0) + 1);
  }

  // Common = sum of min counts for each shared token
  let commonCount = 0;
  for (const [token, predCount] of predictedCounts) {
    const gtCount = groundTruthCounts.get(token) ?? 0;
    commonCount += Math.min(predCount, gtCount);
  }

  if (commonCount === 0) return 0.0;

  const precision = commonCount / predictedTokens.length;
  const recall = commonCount / groundTruthTokens.length;
  const f1 = (2 * precision * recall) / (precision + recall);

  return f1;
}
