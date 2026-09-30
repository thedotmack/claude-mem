
export class ResultFormatter {
  static formatChromaFailureMessage(reason: { message: string; isConnectionError: boolean }): string {
    if (reason.isConnectionError) {
      return `Semantic search is offline (Chroma MCP unreachable: ${reason.message}). Falling back to keyword search; results may be incomplete. Run \`/api/chroma/status?deep=1\` to diagnose.`;
    }
    return `Semantic search failed: ${reason.message}. Falling back to keyword search; results may be incomplete. Check \`~/.claude-mem/logs/\` for the CHROMA_SYNC entry. Run \`/api/chroma/status?deep=1\` for a deeper probe.`;
  }
}
