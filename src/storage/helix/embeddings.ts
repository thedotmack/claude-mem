const EMBEDDING_DIMENSION = 128

function hashToken(token: string): number {
  let hash = 2166136261
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function normalizeSearchText(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/gu)
    .map(token => token.trim())
    .filter(Boolean)
}

export function createDeterministicEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSION).fill(0)
  const tokens = normalizeSearchText(text)
  for (const token of tokens) {
    const hash = hashToken(token)
    const index = hash % EMBEDDING_DIMENSION
    const sign = (hash & 1) === 0 ? 1 : -1
    vector[index] += sign * (1 + (token.length / 32))
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0))
  if (magnitude === 0) {
    return vector
  }
  return vector.map(value => value / magnitude)
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length)
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < length; index++) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude))
}

