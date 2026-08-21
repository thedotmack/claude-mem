
export class ResultFormatter {
  static formatChromaFailureMessage(reason: { message: string; isConnectionError: boolean }): string {
    if (reason.isConnectionError) {
      return `Semantic search is offline (vector index unavailable: ${reason.message}). Falling back to keyword search; results may be incomplete. Check \`~/.claude-mem/logs/\` for the VECTOR_INDEX and VECTOR_SYNC entries.`;
    }
    return `Semantic search failed: ${reason.message}. Falling back to keyword search; results may be incomplete. Check \`~/.claude-mem/logs/\` for the VECTOR_INDEX and VECTOR_SYNC entries.`;
  }
}
