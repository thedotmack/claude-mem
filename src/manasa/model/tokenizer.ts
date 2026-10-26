// SPDX-License-Identifier: Apache-2.0

import type { LanguageAnalysis, SupportedLanguage } from '../types.js';

export const INPUT_FEATURE_DIM = 384;

const SINHALA_CHAR_RE = /[\u0D80-\u0DFF]/g;

/**
 * Authentic Sri Lankan Singlish normalization map (handles phonetic w/v, shorthand, vowel variation).
 */
const SINGLISH_CANONICAL_MAP: Record<string, string> = {
  mchn: 'machan',
  machn: 'machan',
  mcn: 'machan',
  khmda: 'kohomada',
  kohomda: 'kohomada',
  khmada: 'kohomada',
  komada: 'kohomada',
  vada: 'wada',
  vade: 'wade',
  vage: 'wage',
  stuti: 'sthuthi',
  sthuthiyi: 'sthuthi',
  istuti: 'sthuthi',
  kawuda: 'kauda',
  kawda: 'kauda',
  mkd: 'mokada',
  mokda: 'mokada',
  mkakda: 'mokakda',
  mokkda: 'mokakda',
  mnwda: 'monawada',
  mathakda: 'mathakada',
  matakada: 'mathakada',
  mataka: 'mathaka',
  tiyaganna: 'thiyaganna',
  tiyenawa: 'thiyenawa',
  thiyanawa: 'thiyenawa',
  thiyana: 'thiyena',
  plwnd: 'puluwanda',
  puluwnd: 'puluwanda',
  udawu: 'udaw',
  udawwak: 'udaw',
  hri: 'hari',
  niyami: 'niyamai',
  lassani: 'lassanai',
  satutui: 'sathutui',
  sathutu: 'sathutui',
  duki: 'dukai',
  duka: 'dukai',
  aiye: 'aiya',
  malliye: 'malli',
  yalu: 'yaluwa',
  yaluwe: 'yaluwa',
};

/**
 * Core Singlish vocabulary set for reliable Singlish vs English disambiguation.
 */
const SINGLISH_LEXICON = new Set([
  'ayubowan', 'kohomada', 'machan', 'malli', 'aiya', 'akka', 'nangi', 'yaluwa',
  'oya', 'oyata', 'oyage', 'mama', 'mata', 'mage', 'api', 'apita', 'ape',
  'mokada', 'mokakda', 'monawada', 'kauda', 'koheda', 'kawadada', 'ai',
  'hari', 'ow', 'na', 'nae', 'naha', 'epa', 'one', 'ona', 'puluwan', 'puluwanda',
  'ba', 'baha', 'innawa', 'inne', 'yanawa', 'enawa', 'ennam', 'gihin',
  'karanna', 'karanawa', 'karala', 'karamu', 'hadanna', 'hadamu', 'haduwa',
  'kiyanna', 'kiyanne', 'kiwwa', 'balanna', 'danna', 'dannawa', 'danne',
  'mathaka', 'mathakada', 'thiyaganna', 'thiyenawa', 'thiyena', 'hama', 'ekakma',
  'ekak', 'ekata', 'eke', 'wage', 'minihek', 'wada', 'udaw', 'sthuthi', 'bohoma',
  'niyamai', 'supiri', 'lassanai', 'hondai', 'hodai', 'naraka',
  'sathutui', 'dukai', 'mahansi', 'baya', 'kenthi', 'nidimathai', 'ninda',
  'nama', 'gama', 'gedara', 'iskole', 'rassawa', 'kamathi', 'asai',
  'igena', 'igenaganna', 'ugannanna', 'molaya', 'hitha', 'hithanna',
  'suba', 'dawasak', 'rathriyak', 'udasanak', 'budusaranai', 'jayawewa',
  'ada', 'heta', 'iye', 'dan', 'passe', 'poddak', 'godak', 'tikak', 'uth', 'ekakuth',
]);

const ENGLISH_CORE_LEXICON = new Set([
  'the', 'is', 'are', 'am', 'was', 'were', 'what', 'who', 'where', 'when', 'why', 'how',
  'can', 'could', 'would', 'should', 'will', 'please', 'hello', 'hi', 'hey', 'thanks',
  'thank', 'you', 'your', 'my', 'me', 'we', 'our', 'remember', 'memory', 'forget',
  'feel', 'feeling', 'happy', 'sad', 'stressed', 'tired', 'excited', 'anxious',
  'solve', 'calculate', 'explain', 'write', 'code', 'build', 'create', 'plan',
  'brain', 'neural', 'model', 'think', 'learn', 'teach', 'sleep', 'consolidate',
  'good', 'morning', 'night', 'bye', 'goodbye', 'name', 'live', 'like', 'love', 'goal',
]);

/**
 * Cross-lingual semantic concepts: maps Singlish, Sinhala, and English tokens onto shared
 * neural concept channels so the first layer generalizes across all three languages.
 */
const CROSS_LINGUAL_CONCEPTS: Array<{ concept: string; terms: string[] }> = [
  { concept: 'sem:greet', terms: ['hello', 'hi', 'hey', 'ayubowan', 'kohomada', 'ආයුබෝවන්', 'කොහොමද', 'හලෝ', 'සුබ'] },
  { concept: 'sem:identity', terms: ['who', 'kauda', 'කවුද', 'manasa', 'මනස', 'brain', 'molaya', 'මොළය', 'model', 'yourself'] },
  { concept: 'sem:name', terms: ['name', 'nama', 'නම', 'නමක්'] },
  { concept: 'sem:memory_save', terms: ['remember', 'memorize', 'save', 'mathaka', 'thiyaganna', 'මතක', 'තියාගන්න', 'සේව්'] },
  { concept: 'sem:memory_recall', terms: ['recall', 'mathakada', 'මතකද', 'know', 'dannawada', 'දන්නවද', 'told', 'kiwwa', 'කිව්ව'] },
  { concept: 'sem:teach', terms: ['teach', 'learn', 'train', 'ugannanna', 'igenaganna', 'උගන්වන්න', 'ඉගෙනගන්න', 'පුහුණු'] },
  { concept: 'sem:joy', terms: ['happy', 'joy', 'great', 'awesome', 'excited', 'sathutui', 'niyamai', 'supiri', 'සතුටුයි', 'සතුටු', 'නියමයි', 'සුපිරි'] },
  { concept: 'sem:distress', terms: ['sad', 'stressed', 'tired', 'lonely', 'upset', 'worried', 'dukai', 'mahansi', 'baya', 'දුකයි', 'දුක', 'මහන්සියි', 'මහන්සි', 'පාළුයි', 'බයයි'] },
  { concept: 'sem:thanks', terms: ['thanks', 'thank', 'appreciate', 'sthuthi', 'bohoma', 'ස්තූතියි', 'ස්තුතියි', 'බොහොම'] },
  { concept: 'sem:math_reason', terms: ['solve', 'calculate', 'math', 'why', 'reason', 'compare', 'විසඳන්න', 'ගණනය', 'හේතුව', 'hadanna', 'uththara'] },
  { concept: 'sem:code_tech', terms: ['code', 'python', 'javascript', 'typescript', 'sql', 'function', 'algorithm', 'api', 'bug', 'කෝඩ්', 'පයිතන්'] },
  { concept: 'sem:plan', terms: ['plan', 'roadmap', 'schedule', 'steps', 'goal', 'සැලැස්මක්', 'පියවර', 'ඉලක්කය', 'planak'] },
  { concept: 'sem:creative', terms: ['story', 'poem', 'idea', 'imagine', 'creative', 'කතාවක්', 'කවියක්', 'අදහසක්', 'kathawak', 'kawiyak'] },
  { concept: 'sem:sleep', terms: ['sleep', 'consolidate', 'dream', 'compress', 'ninda', 'nidaganna', 'නින්ද', 'නිදාගන්න', 'සිහින'] },
  { concept: 'sem:farewell', terms: ['bye', 'goodbye', 'farewell', 'ennam', 'gihin', 'බායි', 'ගිහින්', 'එන්නම්', 'ජයවේවා', 'බුදුසරණයි'] },
  { concept: 'sem:question', terms: ['what', 'how', 'where', 'when', 'mokakda', 'mokada', 'monawada', 'koheda', 'මොකක්ද', 'මොනවද', 'කොහේද', 'ඇයි'] },
  { concept: 'sem:self_ref', terms: ['my', 'mama', 'mata', 'mage', 'මම', 'මට', 'මගේ'] },
  { concept: 'sem:ai_ref', terms: ['you', 'your', 'oya', 'oyage', 'oyata', 'ඔයා', 'ඔයාගේ', 'ඔයාට'] },
];

const CONCEPT_LOOKUP = new Map<string, string[]>();
for (const entry of CROSS_LINGUAL_CONCEPTS) {
  for (const term of entry.terms) {
    const existing = CONCEPT_LOOKUP.get(term) ?? [];
    existing.push(entry.concept);
    CONCEPT_LOOKUP.set(term, existing);
  }
}

/**
 * Deterministic 32-bit FNV-1a hash for feature hashing into fixed neural dimensions.
 */
export function fnv1aHash(str: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function normalizeTokens(text: string): string[] {
  const cleaned = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s?!+\-*/^=()]/gu, ' ');

  const rawTokens = cleaned
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean);

  return rawTokens.map(token => SINGLISH_CANONICAL_MAP[token] ?? token);
}

/**
 * Detects whether an input is Sinhala script (`sinhala`), Romanized Sinhala (`singlish`), or `english`.
 */
export function analyzeLanguage(text: string): LanguageAnalysis {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      detected: 'english',
      confidence: 0.5,
      sinhalaRatio: 0,
      singlishScore: 0,
      englishScore: 0,
      normalizedTokens: [],
      activeFeatureCount: 0,
    };
  }

  const sinhalaMatches = trimmed.match(SINHALA_CHAR_RE) ?? [];
  const letterMatches = trimmed.match(/\p{L}/gu) ?? [];
  const sinhalaRatio = letterMatches.length > 0 ? sinhalaMatches.length / letterMatches.length : 0;
  const tokens = normalizeTokens(trimmed);

  let singlishHits = 0;
  let englishHits = 0;

  for (const tok of tokens) {
    const cleanTok = tok.replace(/[?!+\-*/^=()]/g, '');
    if (!cleanTok) continue;
    if (SINGLISH_LEXICON.has(cleanTok)) {
      singlishHits += 1.4;
    } else if (/(?:ekak|ekata|gena|wela|karala|nna|wanda|makda|yanna|thiya|ganna|puluwan|aiye|machan)$/i.test(cleanTok)) {
      singlishHits += 1.1;
    }
    if (ENGLISH_CORE_LEXICON.has(cleanTok)) {
      englishHits += 1.0;
    }
  }

  let detected: SupportedLanguage = 'english';
  let confidence = 0.7;

  if (sinhalaRatio >= 0.2) {
    detected = 'sinhala';
    confidence = Math.min(0.99, 0.7 + sinhalaRatio * 0.3);
  } else if (singlishHits > 0 && singlishHits >= englishHits * 0.75) {
    detected = 'singlish';
    confidence = Math.min(0.98, 0.62 + Math.min(0.35, singlishHits * 0.1));
  } else {
    detected = 'english';
    confidence = Math.min(0.97, 0.65 + Math.min(0.3, englishHits * 0.08));
  }

  const vec = encodeTextFeatures(trimmed, tokens, detected);
  let activeFeatureCount = 0;
  for (let i = 0; i < vec.length; i++) {
    if (vec[i] !== 0) activeFeatureCount++;
  }

  return {
    detected,
    confidence: Number(confidence.toFixed(3)),
    sinhalaRatio: Number(sinhalaRatio.toFixed(3)),
    singlishScore: Number(singlishHits.toFixed(2)),
    englishScore: Number(englishHits.toFixed(2)),
    normalizedTokens: tokens,
    activeFeatureCount,
  };
}

/**
 * Encodes trilingual text into a L2-normalized Float64Array(384) neural input vector:
 * - Slots 0..31: Dedicated structural, punctuation, math, & cross-lingual semantic concept channels
 * - Slots 32..383: Signed feature-hashed word unigrams, word bigrams, and character 3/4-grams
 */
export function encodeTextFeatures(
  rawText: string,
  precomputedTokens?: string[],
  detectedLang?: SupportedLanguage,
): Float64Array {
  const vec = new Float64Array(INPUT_FEATURE_DIM);
  const tokens = precomputedTokens ?? normalizeTokens(rawText);

  // Reserved structural & cross-lingual channels (0..31)
  if (rawText.includes('?')) vec[0] = 1.3;
  if (rawText.includes('!')) vec[1] = 1.0;
  if (/\d+\s*[+\-*/^%]\s*\d+/.test(rawText)) vec[2] = 2.0; // Math expression signal
  if (/```|function\s+|const\s+|def\s+|SELECT\s+|import\s+/i.test(rawText)) vec[3] = 1.8; // Code signal
  if (/->|=>|:\s*\S+/.test(rawText)) vec[4] = 1.1; // Structured rule/teach signal

  if (detectedLang === 'singlish') vec[5] = 0.6;
  else if (detectedLang === 'sinhala') vec[6] = 0.6;
  else vec[7] = 0.6;

  vec[8] = Math.min(1.5, tokens.length / 12);

  // Cross-lingual semantic channels (slots 9..28)
  for (const tok of tokens) {
    const clean = tok.replace(/[?!]/g, '');
    const concepts = CONCEPT_LOOKUP.get(clean);
    if (concepts) {
      for (const concept of concepts) {
        const idx = 9 + (fnv1aHash(concept) % 22);
        vec[idx] += 1.65;
      }
    }
    // Prefix/substring match for agglutinative Sinhala & Singlish words
    for (const [term, termConcepts] of CONCEPT_LOOKUP.entries()) {
      if (term.length >= 4 && clean.length > term.length && clean.includes(term)) {
        for (const concept of termConcepts) {
          const idx = 9 + (fnv1aHash(concept) % 22);
          vec[idx] += 1.15;
        }
      }
    }
  }

  const HASH_SPACE = INPUT_FEATURE_DIM - 32;
  const addHashed = (feature: string, weight: number) => {
    const h1 = fnv1aHash(feature, 2166136261);
    const h2 = fnv1aHash(feature, 1469598103);
    const slot = 32 + (h1 % HASH_SPACE);
    const sign = (h2 & 1) === 0 ? 1 : -1;
    vec[slot] += sign * weight;
  };

  // Word unigrams & bigrams
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i].replace(/[?!]/g, '');
    if (!tok) continue;
    addHashed(`w:${tok}`, 1.4);

    if (i + 1 < tokens.length) {
      const next = tokens[i + 1].replace(/[?!]/g, '');
      if (next) addHashed(`bg:${tok}_${next}`, 1.15);
    }

    // Character 3-grams and 4-grams with boundary markers (robust to typos & Sinhala/Singlish suffixes)
    const padded = `<${tok}>`;
    for (let j = 0; j + 3 <= padded.length; j++) {
      addHashed(`c3:${padded.slice(j, j + 3)}`, 0.45);
    }
    for (let j = 0; j + 4 <= padded.length; j++) {
      addHashed(`c4:${padded.slice(j, j + 4)}`, 0.35);
    }
  }

  // L2 normalize so gradient scales remain crisp and well-conditioned across short/long inputs
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) normSq += vec[i] * vec[i];
  if (normSq > 1e-12) {
    const invNorm = 1 / Math.sqrt(normSq);
    for (let i = 0; i < vec.length; i++) vec[i] *= invNorm;
  }

  return vec;
}
