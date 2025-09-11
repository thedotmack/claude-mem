/**
 * ChunkManager - Handles intelligent chunking of large transcripts
 * 
 * This class manages the splitting of large filtered transcripts into chunks
 * that fit within Claude's 32k token limit while preserving conversation context
 * and maintaining message integrity.
 */

export interface ChunkMetadata {
  chunkNumber: number;
  totalChunks: number;
  startIndex: number;
  endIndex: number;
  messageCount: number;
  estimatedTokens: number;
  sizeBytes: number;
  hasOverlap: boolean;
  overlapMessages?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
}

export interface ChunkingOptions {
  maxTokensPerChunk?: number;  // default: 28000 (leaving 4k buffer)
  maxBytesPerChunk?: number;   // default: 98000 (98KB)
  preserveContext?: boolean;   // keep context overlap between chunks
  contextOverlap?: number;     // messages to repeat (default: 2)
  parallel?: boolean;          // process chunks in parallel
}

export interface ChunkedMessage {
  content: string;
  estimatedTokens: number;
}

export class ChunkManager {
  private static readonly DEFAULT_MAX_TOKENS = 28000;
  private static readonly DEFAULT_MAX_BYTES = 98000;
  private static readonly DEFAULT_CONTEXT_OVERLAP = 2;
  private static readonly CHARS_PER_TOKEN_ESTIMATE = 3.5;

  private options: Required<ChunkingOptions>;

  constructor(options: ChunkingOptions = {}) {
    this.options = {
      maxTokensPerChunk: options.maxTokensPerChunk ?? ChunkManager.DEFAULT_MAX_TOKENS,
      maxBytesPerChunk: options.maxBytesPerChunk ?? ChunkManager.DEFAULT_MAX_BYTES,
      preserveContext: options.preserveContext ?? true,
      contextOverlap: options.contextOverlap ?? ChunkManager.DEFAULT_CONTEXT_OVERLAP,
      parallel: options.parallel ?? false
    };
  }

  /**
   * Estimates token count for a given text
   * Uses rough approximation of 3.5 characters per token
   */
  public estimateTokenCount(text: string): number {
    return Math.ceil(text.length / ChunkManager.CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Parses the filtered output format into structured messages
   * Format: "- content"
   */
  public parseFilteredOutput(filteredContent: string): ChunkedMessage[] {
    const lines = filteredContent.split('\n').filter(line => line.trim());
    const messages: ChunkedMessage[] = [];

    for (const line of lines) {
      // Parse format: "- content"
      if (line.startsWith('- ')) {
        const content = line.substring(2); // Remove "- " prefix
        messages.push({
          content,
          estimatedTokens: this.estimateTokenCount(content)
        });
      }
    }

    return messages;
  }

  /**
   * Chunks the filtered transcript into manageable pieces
   */
  public chunkTranscript(filteredContent: string): Array<{ content: string; metadata: ChunkMetadata }> {
    const messages = this.parseFilteredOutput(filteredContent);
    const chunks: Array<{ content: string; metadata: ChunkMetadata }> = [];
    
    let currentChunk: ChunkedMessage[] = [];
    let currentTokens = 0;
    let currentBytes = 0;
    let chunkStartIndex = 0;

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const messageText = this.formatMessage(message);
      const messageBytes = Buffer.byteLength(messageText, 'utf8');
      const messageTokens = message.estimatedTokens;

      // Check if adding this message would exceed limits
      if (currentChunk.length > 0 && 
          (currentTokens + messageTokens > this.options.maxTokensPerChunk ||
           currentBytes + messageBytes > this.options.maxBytesPerChunk)) {
        
        // Save current chunk
        const chunkContent = this.formatChunk(currentChunk);
        chunks.push({
          content: chunkContent,
          metadata: {
            chunkNumber: chunks.length + 1,
            totalChunks: 0, // Will be updated after all chunks are created
            startIndex: chunkStartIndex,
            endIndex: i - 1,
            messageCount: currentChunk.length,
            estimatedTokens: currentTokens,
            sizeBytes: currentBytes,
            hasOverlap: false
          }
        });

        // Start new chunk with optional context overlap
        currentChunk = [];
        currentTokens = 0;
        currentBytes = 0;
        chunkStartIndex = i;

        // Add overlap messages from previous chunk if enabled
        if (this.options.preserveContext && chunks.length > 0) {
          const overlapStart = Math.max(0, i - this.options.contextOverlap);
          for (let j = overlapStart; j < i; j++) {
            const overlapMessage = messages[j];
            const overlapText = this.formatMessage(overlapMessage);
            currentChunk.push(overlapMessage);
            currentTokens += overlapMessage.estimatedTokens;
            currentBytes += Buffer.byteLength(overlapText, 'utf8');
          }
          
          if (currentChunk.length > 0) {
            // Mark that this chunk has overlap
            chunkStartIndex = overlapStart;
          }
        }
      }

      // Add message to current chunk
      currentChunk.push(message);
      currentTokens += messageTokens;
      currentBytes += messageBytes;
    }

    // Save final chunk if it has content
    if (currentChunk.length > 0) {
      const chunkContent = this.formatChunk(currentChunk);
      chunks.push({
        content: chunkContent,
        metadata: {
          chunkNumber: chunks.length + 1,
          totalChunks: 0,
          startIndex: chunkStartIndex,
          endIndex: messages.length - 1,
          messageCount: currentChunk.length,
          estimatedTokens: currentTokens,
          sizeBytes: currentBytes,
          hasOverlap: this.options.preserveContext && chunks.length > 0
        }
      });
    }

    // Update total chunks count in metadata
    chunks.forEach(chunk => {
      chunk.metadata.totalChunks = chunks.length;
    });

    return chunks;
  }

  /**
   * Formats a single message back to the filtered output format
   */
  private formatMessage(message: ChunkedMessage): string {
    return `- ${message.content}`;
  }

  /**
   * Formats a chunk of messages
   */
  private formatChunk(messages: ChunkedMessage[]): string {
    return messages.map(m => this.formatMessage(m)).join('\n');
  }

  /**
   * Creates a header for a chunk file with metadata
   */
  public createChunkHeader(metadata: ChunkMetadata): string {
    const lines = [];

    // Add timestamp range if available, otherwise chunk number
    if (metadata.firstTimestamp && metadata.lastTimestamp) {
      lines.push(`# ${metadata.firstTimestamp} to ${metadata.lastTimestamp} (chunk ${metadata.chunkNumber}/${metadata.totalChunks})`);
    } else {
      lines.push(`# Chunk ${metadata.chunkNumber} of ${metadata.totalChunks}`);
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Checks if content needs chunking based on size
   */
  public needsChunking(content: string): boolean {
    const estimatedTokens = this.estimateTokenCount(content);
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    
    return estimatedTokens > this.options.maxTokensPerChunk || 
           sizeBytes > this.options.maxBytesPerChunk;
  }

  /**
   * Gets chunking statistics for logging
   */
  public getChunkingStats(chunks: Array<{ metadata: ChunkMetadata }>): string {
    const totalMessages = chunks.reduce((sum, c) => sum + c.metadata.messageCount, 0);
    const totalTokens = chunks.reduce((sum, c) => sum + c.metadata.estimatedTokens, 0);
    const totalBytes = chunks.reduce((sum, c) => sum + c.metadata.sizeBytes, 0);
    
    return [
      `📊 Chunking Statistics:`,
      `  • Total chunks: ${chunks.length}`,
      `  • Total messages: ${totalMessages}`,
      `  • Total estimated tokens: ${totalTokens.toLocaleString()}`,
      `  • Total size: ${(totalBytes / 1024).toFixed(1)} KB`,
      `  • Average tokens per chunk: ${Math.round(totalTokens / chunks.length).toLocaleString()}`,
      `  • Average size per chunk: ${(totalBytes / chunks.length / 1024).toFixed(1)} KB`
    ].join('\n');
  }
}