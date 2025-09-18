import { query } from '@anthropic-ai/claude-code';
import fs, { createWriteStream, WriteStream } from 'fs';
import path, { join } from 'path';
import os from 'os';
import { PathResolver } from '../../shared/paths.js';
import { PathDiscovery } from '../../services/path-discovery.js';
import { PromptOrchestrator, createAnalysisContext } from '../orchestration/PromptOrchestrator.js';
import { DEBUG_MESSAGES } from '../../constants.js';
import { log } from '../../shared/logger.js';
import { CompressionError } from '../../shared/types.js';
import { getClaudePath } from '../../shared/settings.js';
import { ChunkManager, ChunkingOptions, ChunkMetadata } from './ChunkManager.js';
import { getStorageProvider, needsMigration } from '../../shared/storage.js';
import { SessionInput, MemoryInput, OverviewInput, DiagnosticInput } from '../../services/sqlite/types.js';

/**
 * Interface for message objects in transcript
 */
interface TranscriptMessage {
  type: string;
  message?: {
    content?: string | Array<{
      text?: string;
      content?: string;
    }>;
    role?: string;
    timestamp?: string;
    created_at?: string;
  };
  content?: string | Array<{
    text?: string;
    content?: string;
  }>;
  role?: string;
  uuid?: string;
  session_id?: string;
  parent_tool_use_id?: string;
  timestamp?: string;
  created_at?: string;
  subtype?: string;
  result?: string;
  model?: string;
  tools?: unknown[];
  mcp_servers?: unknown[];
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
    interrupted?: boolean;
    isImage?: boolean;
  };
}


/**
 * Compression options for the TranscriptCompressor
 */
export interface CompressionOptions {
  output?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

/**
 * TranscriptCompressor handles the analysis and compression of Claude Code conversation transcripts
 * into a searchable memory database format using the Model Context Protocol.
 */
export class TranscriptCompressor {
  private paths: PathResolver;
  private logStream: WriteStream | null = null;
  private logFile: string | null = null;
  private promptOrchestrator: PromptOrchestrator;
  private chunkManager: ChunkManager;

  // <Block> 1.1 ====================================
  // Constructor Initialization - Natural flow (8/10)
  constructor(options: CompressionOptions = {}) {
    this.paths = new PathResolver();
    this.promptOrchestrator = new PromptOrchestrator();
    this.chunkManager = new ChunkManager();
    this.ensureClaudeMemStructure();
    this.initializeLogging();
    
    log.debug('🤖 TranscriptCompressor initialized');
  }
  // </Block> =======================================

  // <Block> 1.2 ====================================
  // Directory Structure Validation - Natural flow (8/10)
  /**
   * Ensures that the required directory structure exists
   */
  private ensureClaudeMemStructure(): void {
    const configDir = this.paths.getConfigDir();
    const indexDir = this.paths.getIndexDir();
    const archiveDir = this.paths.getArchiveDir();
    const logsDir = this.paths.getLogsDir();
    
    PathResolver.ensureDirectories([configDir, indexDir, archiveDir, logsDir]);
  }

  private initializeLogging(): void {
    const logsDir = this.paths.getLogsDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logFile = join(logsDir, `claude-mem-${timestamp}.log`);
    this.logStream = createWriteStream(this.logFile, { flags: 'a' });
    
    this.debugLog('🚀 DEBUG LOG STARTED');
    this.debugLog(`📁 Log file: ${this.logFile}`);
    this.debugLog('═'.repeat(60));
  }

  private debugLog(message: string): void {
    if (!this.logStream) return;
    
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    this.logStream.write(logLine);
  }

  private closeLogging(): void {
    if (this.logStream) {
      this.debugLog('✅ DEBUG LOG ENDED');
      this.logStream.end();
    }
  }
  // </Block> =======================================

  // <Block> 1.3 ====================================
  // </Block> =======================================

  // <Block> 1.4 ====================================
  // Main Compression Flow - DEBUG GUARDS INTERRUPT FLOW (5/10)
  /**
   * Main compression method that processes a transcript and creates compressed memories
   * Now supports automatic chunking for large transcripts
   * @param transcriptPath - Path to the transcript file
   * @param sessionId - Optional session ID
   * @param originalProjectName - Optional original project name (for imported transcripts)
   */
  async compress(transcriptPath: string, sessionId?: string, originalProjectName?: string): Promise<string> {
    this.debugLog(`🚀 Starting compression for: ${transcriptPath}`);
    this.debugLog(`📋 Session ID: ${sessionId || 'auto-generated'}`);

    try {
      // Use original project name if provided (for imports), otherwise use current project
      const projectPrefix = originalProjectName || PathResolver.getCurrentProjectPrefix();
      log.debug(DEBUG_MESSAGES.PROJECT_NAME(projectPrefix));
      this.debugLog(`📝 PROJECT PREFIX: ${projectPrefix}`);

      // Read and parse transcript
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      this.debugLog(`📖 Reading transcript: ${content.length} bytes`);
      const lines = content.trim().split('\n').filter(line => line.trim());
      const messages: TranscriptMessage[] = [];
      let parseErrors = 0;

      for (let i = 0; i < lines.length; i++) {
        try {
          const parsed = JSON.parse(lines[i]);
          messages.push(parsed);
        } catch (e) {
          parseErrors++;
          log.debug(`Parse error on line ${i + 1}: ${(e as Error).message}`);
        }
      }

      log.debug(DEBUG_MESSAGES.TRANSCRIPT_STATS(content.length, messages.length));
      if (parseErrors > 0) {
        log.debug(`Parse errors: ${parseErrors}`);
      }
      this.debugLog(`📊 Transcript loaded: ${lines.length} lines, ${messages.length} messages, ${parseErrors} parse errors`);

      // Generate final session ID
      const finalSessionId = sessionId || path.basename(transcriptPath, '.jsonl');

      // Get timestamp from last message or use current time
      // Reverse search for the last message with a valid timestamp
      let timestamp = new Date().toISOString();
      
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.timestamp) {
          try {
            // Handle both ISO strings and Unix timestamps
            const ts = msg.timestamp;
            let parsedDate: Date;
            
            // Check if it's already an ISO string or a Unix timestamp
            if (typeof ts === 'string' && ts.includes('T')) {
              // It's likely an ISO string
              parsedDate = new Date(ts);
            } else {
              // It's likely a Unix timestamp (number or numeric string)
              const numTs = Number(ts);
              // Check if timestamp is in seconds (Unix) or milliseconds
              // Unix timestamps are typically 10 digits, JS timestamps are 13
              const dateValue = numTs < 10000000000 ? numTs * 1000 : numTs;
              parsedDate = new Date(dateValue);
            }
            
            if (!isNaN(parsedDate.getTime())) {
              timestamp = parsedDate.toISOString();
              this.debugLog(`📅 Using timestamp from last message: ${timestamp}`);
              break;
            }
          } catch (e) {
            // Continue searching for a valid timestamp
            this.debugLog(`⚠️ Invalid timestamp in message: ${msg.timestamp}, trying earlier message`);
          }
        }
      }

      // Archive filename for reference
      const archiveFilename = `${finalSessionId}.jsonl.archive`;

      // Format conversation for analysis
      const conversationText = this.formatConversationForPrompt(messages);
      
      // Check if we need to use chunked processing
      const needsChunking = this.chunkManager.needsChunking(conversationText);
      
      let summaries: any[] = [];
      let overview: string | null = null;
      
      if (needsChunking) {
        // Use chunked processing for large transcripts
        const chunkResult = await this.compressInChunks(messages, finalSessionId, projectPrefix);
        summaries = chunkResult.summaries;
        overview = chunkResult.overview;
      } else {
        // Use normal single-pass processing for smaller transcripts
        // Create analysis prompt using PromptOrchestrator
        const analysisContext = createAnalysisContext(
          conversationText,
          finalSessionId,
          {
            projectName: projectPrefix,
            trigger: 'manual'
          }
        );
        
        const analysisPrompt = this.promptOrchestrator.createAnalysisPrompt(analysisContext);

        log.debug('📤 Analysis prompt created');
        log.debug(`📊 Prompt length: ${analysisPrompt.prompt.length} characters`);
        
        // LOG THE FULL PROMPT TO DEBUG FILE
        const promptDebugPath = path.join(this.paths.getLogsDir(), `claude-prompt-${Date.now()}.txt`);
        fs.writeFileSync(promptDebugPath, `=== CLAUDE ANALYSIS PROMPT ===\n${analysisPrompt.prompt}\n`);
        this.debugLog(`📝 Full prompt saved to: ${promptDebugPath}`);

        // Find MCP config and get Claude path from settings
        const claudePath = getClaudePath();
        const mcpConfigPath = this.findMCPConfig();

        log.debug(DEBUG_MESSAGES.CLAUDE_PATH_FOUND(claudePath));
        if (mcpConfigPath) {
          log.debug(DEBUG_MESSAGES.MCP_CONFIG_USED(mcpConfigPath));
        }

        // Call Claude SDK for analysis  
        this.debugLog('🤖 Calling Claude SDK with MCP tools...');
        const response = await query({
        prompt: analysisPrompt.prompt,
        options: {
          allowedTools: [
            'mcp__claude-mem__chroma_list_collections',
            'mcp__claude-mem__chroma_create_collection',
            'mcp__claude-mem__chroma_peek_collection',
            'mcp__claude-mem__chroma_get_collection_info',
            'mcp__claude-mem__chroma_get_collection_count',
            'mcp__claude-mem__chroma_modify_collection',
            'mcp__claude-mem__chroma_fork_collection',
            'mcp__claude-mem__chroma_delete_collection',
            'mcp__claude-mem__chroma_add_documents',
            'mcp__claude-mem__chroma_query_documents',
            'mcp__claude-mem__chroma_get_documents',
            'mcp__claude-mem__chroma_update_documents',
            'mcp__claude-mem__chroma_delete_documents',
          ],
          pathToClaudeCodeExecutable: getClaudePath(),
          model: 'sonnet'
        },
      });
        this.debugLog('✅ Claude SDK response received');

        // Process response and extract summaries from JSON
        this.debugLog('🔄 Processing Claude JSON response...');
        const extractResult = await this.processClaudeResponse(response);
        this.debugLog(`📋 Extracted ${extractResult.summaries.length} summaries from JSON`);
        if (extractResult.overview) {
          this.debugLog(`📝 Overview: ${extractResult.overview}`);
        }
        
        summaries = extractResult.summaries;
        overview = extractResult.overview;
      }

      log.debug(DEBUG_MESSAGES.COMPRESSION_COMPLETE(summaries.length));

      // Continue processing even with zero summaries - let the natural flow handle empty results

      // Create archive and update index
      const archivePath = this.createArchive(transcriptPath, projectPrefix, finalSessionId, content);
      this.debugLog(`📦 Archive created: ${archivePath}`);
      
      // Write to index - same method for both chunked and non-chunked
      await this.appendToIndex(summaries, overview, projectPrefix, finalSessionId, messages, archivePath, timestamp);
      this.debugLog(`📥 Written ${summaries.length} summaries to index`);

      log.debug(`✅ SUCCESS`);
      log.debug(`Archive created: ${archivePath}`);
      log.debug(`Summaries created: ${summaries.length}`);
      
      this.debugLog('✅ Compression completed successfully');
      this.closeLogging();

      return archivePath;
    } catch (error) {
      log.error('COMPRESSION FAILED', error, {
        transcriptPath,
        sessionId
      });
      this.debugLog(`❌ ERROR: ${error instanceof Error ? error.message : String(error)}`);
      this.closeLogging();
      throw error;
    }
  }
  // </Block> =======================================


  /**
   * Finds MCP configuration file
   */
  private findMCPConfig(): string {
    const pathDiscovery = PathDiscovery.getInstance();
    const possibleConfigs = [
      pathDiscovery.getProjectMcpConfigPath(),
      pathDiscovery.getMcpConfigPath(),
      join(pathDiscovery.getClaudeConfigDirectory(), '.mcp.json'),
    ];

    const mcpConfigPath = possibleConfigs.find(fs.existsSync);
    return mcpConfigPath || pathDiscovery.getMcpConfigPath();
  }

  // <Block> 1.5 ====================================
  // Claude Response Processing - JSON extraction with pipe-separated output (9/10)
  /**
   * Processes Claude response to extract summaries from JSON
   */
  private async processClaudeResponse(response: any): Promise<{ overview: string | null; summaries: string[] }> {
    let fullContent = '';

    // Extract content using polymorphic handlers
    fullContent = await this.extractResponseContent(response, []);

    // DEBUG: Log the full content to see what Claude is returning
    this.debugLog(`🔍 Claude response content length: ${fullContent.length}`);
    
    // Write raw response to debug file for troubleshooting
    const debugPath = path.join(this.paths.getLogsDir(), `claude-response-${Date.now()}.txt`);
    fs.writeFileSync(debugPath, `=== CLAUDE RAW RESPONSE ===\n${fullContent}\n`);
    this.debugLog(`📝 Raw response saved to: ${debugPath}`);

    // Extract JSON from response tags
    const extractResult = this.extractJSONResponse(fullContent);
    
    this.debugLog(`📊 Extracted ${extractResult.summaries.length} summaries from JSON`);
    if (extractResult.summaries.length === 0) {
      this.debugLog(`⚠️ No summaries found in JSON response`);
    }
    
    return extractResult;
  }

  /**
   * Extracts content from response
   */
  private async extractResponseContent(response: any, summaries: any[]): Promise<string> {
    // Handle streaming response
    if (response && typeof response === 'object' && Symbol.asyncIterator in response) {
      let content = '';
      let inJSONResponse = false;
      
      for await (const message of response) {
        const chunk = this.extractMessageContent(message);
        content += chunk;
        
        // Check if we're entering or exiting JSON response tags
        if (chunk.includes('<JSONResponse>')) {
          inJSONResponse = true;
        }
        if (chunk.includes('</JSONResponse>')) {
          inJSONResponse = false;
          continue; // Skip printing the closing tag
        }
        
        // Only show Claude's thinking, not the JSON response
        if (chunk && !inJSONResponse) {
          process.stdout.write(chunk);
        }
        
        if (message?.type === 'result' && message?.result) {
          content = message.result;
        }
      }
      return content;
    }
    
    // Handle string response
    if (typeof response === 'string') {
      return response;
    }
    
    // Handle array response
    if (Array.isArray(response)) {
      return response.map(item => {
        if (typeof item === 'string') return item;
        if (item?.text) return item.text;
        if (item?.content) return item.content;
        return '';
      }).filter(Boolean).join('\n');
    }
    
    // Handle object response
    if (typeof response === 'object' && response !== null) {
      if (response?.text) return response.text;
      if (response?.content) return response.content;
      if (response?.message) return response.message;
      return '';
    }
    
    return '';
  }


  /**
   * Extracts content from a single message
   */
  private extractMessageContent(message: any): string {
    let content = '';
    if (message?.content) content += message.content;
    if (message?.text) content += message.text;
    if (message?.data) content += message.data;
    
    if (message?.message?.content && Array.isArray(message.message.content)) {
      message.message.content.forEach((item: any) => {
        if (item.type === 'text' && item.text) {
          content += item.text;
        }
      });
    }
    
    return content;
  }

  /**
   * Extracts JSON response and returns raw JSON objects
   */
  private extractJSONResponse(content: string): { overview: string | null; summaries: any[] } {
    try {
      // Extract JSON from response tags
      const jsonMatch = content.match(/<JSONResponse>([\s\S]*?)<\/JSONResponse>/);
      
      if (!jsonMatch) {
        this.debugLog(`⚠️ No <JSONResponse> tags found in response`);
        return { overview: null, summaries: [] };
      }
      
      const jsonContent = jsonMatch[1].trim();
      this.debugLog(`✅ Found JSON response: ${jsonContent.length} chars`);
      
      // Parse the JSON
      const parsed = JSON.parse(jsonContent);
      
      if (!parsed.summaries || !Array.isArray(parsed.summaries)) {
        this.debugLog(`⚠️ Invalid JSON structure: missing summaries array`);
        return { overview: null, summaries: [] };
      }
      
      // Return raw JSON objects instead of converting to pipe-separated format
      const validSummaries: any[] = [];
      
      parsed.summaries.forEach((summary: any, index: number) => {
        if (!summary.text || !summary.document_id) {
          this.debugLog(`⚠️ Skipping invalid summary at index ${index}`);
          return;
        }
        
        // Ensure required fields are present
        const validSummary = {
          text: summary.text,
          document_id: summary.document_id,
          keywords: summary.keywords || '',
          timestamp: summary.timestamp || new Date().toISOString(),
          archive: summary.archive || `${summary.document_id}.jsonl.archive`
        };
        
        validSummaries.push(validSummary);
        this.debugLog(`✅ Valid summary ${index + 1}: ${summary.document_id}`);
      });
      
      // Store overview if present
      if (parsed.overview) {
        this.debugLog(`📝 Session overview: ${parsed.overview}`);
      }
      
      return { overview: parsed.overview || null, summaries: validSummaries };
      
    } catch (error) {
      this.debugLog(`❌ Failed to parse JSON response: ${error}`);
      
      // Fallback: try to extract any pipe-separated lines that might exist
      this.debugLog(`🔄 Attempting fallback to pipe-separated format...`);
      const legacyLines = this.extractLegacyPipeSeparatedLines(content);
      // Convert legacy lines to JSON format for consistency
      const legacySummaries = legacyLines.map((line, index) => {
        const parts = line.split(' | ');
        return {
          text: parts[0] || '',
          document_id: parts[1] || `legacy_${Date.now()}_${index}`,
          keywords: parts[2] || '',
          timestamp: parts[3] || new Date().toISOString(),
          archive: parts[4] || `legacy_${Date.now()}_${index}.jsonl.archive`
        };
      });
      return { overview: null, summaries: legacySummaries };
    }
  }
  
  /**
   * Legacy fallback for pipe-separated format
   */
  private extractLegacyPipeSeparatedLines(content: string): string[] {
    const lines = content.split('\n');
    const pipeLines: string[] = [];
    
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && trimmed.includes(' | ') && trimmed.split(' | ').length >= 3) {
        pipeLines.push(trimmed);
      }
    });
    
    this.debugLog(`📊 Fallback extracted ${pipeLines.length} pipe-separated lines`);
    return pipeLines;
  }
  // </Block> =======================================

  // <Block> 1.7 ====================================
  // Conversation Formatting - LONG BUT MOSTLY NATURAL (6/10)
  /**
   * Processes a transcript in chunks when it's too large for single processing
   */
  private async compressInChunks(
    messages: TranscriptMessage[],
    sessionId: string,
    projectPrefix: string
  ): Promise<{ summaries: any[]; overview: string | null }> {
    this.debugLog('📦 Large transcript detected, processing in chunks...');
    
    // Create filtered output for chunking
    const outputLines: string[] = [];
    messages.forEach((m, index) => {
      const filteredContent = this.extractContent(m);
      const singleLine = filteredContent.replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/\r/g, '\\n');
      outputLines.push(`- ${singleLine}`);
    });
    
    const fullOutput = outputLines.join('\n');
    const chunks = this.chunkManager.chunkTranscript(fullOutput);
    
    this.debugLog(this.chunkManager.getChunkingStats(chunks));
    console.log(`\n📊 Processing ${chunks.length} chunks...`);
    
    const allSummaries: any[] = [];
    const chunkOverviews: string[] = [];

    // Process each chunk and collect overviews
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`\n🔄 Processing chunk ${i + 1}/${chunks.length}...`);
      
      // Create analysis prompt for this chunk
      const chunkPrompt = `Analyze this chunk (${i + 1}/${chunks.length}) of a larger conversation transcript.
      
${chunk.metadata.hasOverlap ? `Note: This chunk includes ${chunk.metadata.overlapMessages || 2} messages from the previous chunk for context continuity.` : ''}

Chunk contains messages ${chunk.metadata.startIndex + 1} to ${chunk.metadata.endIndex + 1}.

${chunk.content}`;

      const analysisPrompt = this.promptOrchestrator.createAnalysisPrompt({
        transcriptContent: chunkPrompt,
        sessionId: sessionId,
        projectName: projectPrefix,
        trigger: 'manual',
        originalTokens: chunk.metadata.estimatedTokens
      });

      // Find MCP config and get Claude path
      const claudePath = getClaudePath();
      const mcpConfigPath = this.findMCPConfig();
      
      if (mcpConfigPath) {
        log.debug(DEBUG_MESSAGES.MCP_CONFIG_USED(mcpConfigPath));
      }

      // Call Claude SDK for this chunk
      const response = await query({
        prompt: analysisPrompt.prompt,
        options: {
          allowedTools: [
            'mcp__claude-mem__chroma_list_collections',
            'mcp__claude-mem__chroma_create_collection',
            'mcp__claude-mem__chroma_peek_collection',
            'mcp__claude-mem__chroma_get_collection_info',
            'mcp__claude-mem__chroma_get_collection_count',
            'mcp__claude-mem__chroma_modify_collection',
            'mcp__claude-mem__chroma_fork_collection',
            'mcp__claude-mem__chroma_delete_collection',
            'mcp__claude-mem__chroma_add_documents',
            'mcp__claude-mem__chroma_query_documents',
            'mcp__claude-mem__chroma_get_documents',
            'mcp__claude-mem__chroma_update_documents',
            'mcp__claude-mem__chroma_delete_documents',
          ],
          pathToClaudeCodeExecutable: getClaudePath(),
          model: 'sonnet'
        },
      });
      
      // Extract summaries from this chunk's response (ignoring overview from chunks)
      const responseContent = await this.extractResponseContent(response, []);
      const extractResult = this.extractJSONResponse(responseContent);
      
      if (extractResult.summaries.length > 0) {
        console.log(`  ✅ Extracted ${extractResult.summaries.length} memories from chunk ${i + 1}`);
        allSummaries.push(...extractResult.summaries);
      } else {
        console.log(`  ⚠️ No memories extracted from chunk ${i + 1}`);
      }
    }
    
    // After all chunks are processed, generate a single overview from the saved memories
    console.log(`\n📝 Generating overview from ${allSummaries.length} extracted memories...`);
    const overview = await this.generateOverviewFromMemories(projectPrefix, sessionId, allSummaries);
    
    return { summaries: allSummaries, overview };
  }

  /**
   * Generates a single overview from the memories that were saved to Chroma
   */
  private async generateOverviewFromMemories(
    projectPrefix: string,
    sessionId: string,
    summaries: any[]
  ): Promise<string | null> {
    try {
      // Extract memory texts from the summaries for the overview prompt
      const memoryTexts = summaries.map(s => s.text || s).filter(Boolean);
      
      if (memoryTexts.length === 0) {
        console.log('  ⚠️ No memories available to generate overview');
        return null;
      }
      
      // Create a focused prompt for overview generation
      const overviewPrompt = `You have just analyzed a long conversation and extracted ${memoryTexts.length} key memories.
Based on these memories, create a comprehensive overview of the entire session.

MEMORIES EXTRACTED:
${memoryTexts.map((text, i) => `${i + 1}. ${text}`).join('\n')}

PROJECT: ${projectPrefix}
SESSION: ${sessionId}

Create a 2-3 sentence overview that:
1. Summarizes the main themes and accomplishments across ALL the memories
2. Highlights the most significant technical work or decisions
3. Written for any developer to understand (define jargon organically)

Return ONLY the overview text, nothing else.`;

      // Call Claude for overview generation
      const response = await query({
        prompt: overviewPrompt,
        options: {
          allowedTools: [], // No tools needed for overview generation
          pathToClaudeCodeExecutable: getClaudePath(),
          model: 'sonnet'
        },
      });
      
      // Extract the overview from response
      let overview = '';
      if (response && typeof response === 'object' && Symbol.asyncIterator in response) {
        for await (const message of response) {
          const chunk = this.extractMessageContent(message);
          overview += chunk;
          
          if (message?.type === 'result' && message?.result) {
            overview = message.result;
          }
        }
      } else if (typeof response === 'string') {
        overview = response;
      } else if (response?.text) {
        overview = response.text;
      } else if (response?.content) {
        overview = response.content;
      }
      
      const cleanedOverview = overview.trim();
      if (cleanedOverview) {
        console.log(`  ✅ Overview generated successfully`);
        return cleanedOverview;
      } else {
        console.log(`  ⚠️ No overview generated`);
        return null;
      }
    } catch (error) {
      console.error(`  ❌ Failed to generate overview: ${error}`);
      this.debugLog(`❌ Overview generation error: ${error}`);
      return null;
    }
  }

  /**
   * Formats conversation messages for analysis prompt
   */
  private formatConversationForPrompt(messages: TranscriptMessage[]): string {
    const pipeLines: string[] = [];

    messages.forEach((m, index) => {
      const role = m.type === 'assistant' ? 'assistant' 
        : m.type === 'user' ? 'user'
        : (m.type === 'result' || m.type === 'system' || m.type === 'summary') ? 'system'
        : m.message?.role || m.role;

      const content = this.extractContent(m);
      const sessionId = m.session_id || '';
      const timestamp = this.normalizeTimestamp(m);
      const messageUuid = m.uuid || '';

      // Escape pipe characters in content to prevent format corruption
      const escapedContent = content.replace(/\|/g, '\\|');

      // Format: content | session_id | role | timestamp | message_uuid
      const pipeLine = `${escapedContent} | ${sessionId} | ${role} | ${timestamp} | ${messageUuid}`;
      pipeLines.push(pipeLine);
    });

    log.debug(`Field filtering complete: ${pipeLines.length} messages processed`);

    return `<!-- TRANSCRIPT -->\n${pipeLines.join('\n')}\n<!-- /TRANSCRIPT -->`;
  }
  // </Block> =======================================

  // <Block> 1.6 ====================================
  // Message Content Extraction - Simplified (8/10)
  /**
   * Extracts content from message object
   */
  private extractContent(m: TranscriptMessage): string {
    let content = '';
    
    // Handle tool_result messages first - check for large content
    if (m.type === 'tool_result') {
      return this.extractToolResultContent(m);
    }
    
    // Extract by type
    if (m.type === 'assistant' || m.type === 'user') {
      const messageContent = m.message?.content;
      if (Array.isArray(messageContent)) {
        // Properly handle content arrays without aggressive filtering
        content = messageContent
          .map((item) => this.extractContentItem(item))
          .filter(Boolean)
          .join(' ');
      } else if (messageContent) {
        content = String(messageContent).trim();
      }
    } else if (m.type === 'summary') {
      // Handle summary messages that have a different structure
      content = (m as any).summary || '';
    } else if (m.type === 'result') {
      if (m.subtype === 'success' && m.result) {
        content = `[Result: ${m.result}]`;
      } else if (m.subtype === 'error_max_turns') {
        content = '[Error: Maximum turns reached]';
      } else if (m.subtype === 'error_during_execution') {
        content = '[Error during execution]';
      }
    } else if (m.type === 'system') {
      if (m.subtype === 'init') {
        content = `[System initialized: ${m.model}, tools: ${m.tools?.length || 0}, MCP servers: ${m.mcp_servers?.length || 0}]`;
      } else {
        // Handle other system messages
        content = String(m.content || '').trim();
      }
    }
    
    // Fallback to generic content extraction
    if (!content) {
      content = String(m.message?.content || m.content || '');
      if (Array.isArray(content)) {
        content = content
          .map((item) => item.text || item.content || '')
          .filter(Boolean)
          .join(' ');
      }
    }

    // Append tool use result if present
    if (m.toolUseResult) {
      const toolSummary = this.summarizeToolResult(m.toolUseResult, content);
      if (toolSummary) {
        content = content ? `${content}\n\n${toolSummary}` : toolSummary;
      }
    }

    return String(content).trim();
  }

  /**
   * Extracts content from individual content items (text, tool_use, etc.)
   */
  private extractContentItem(item: any): string {
    if (!item || typeof item !== 'object') {
      return String(item || '').trim();
    }
    
    // Handle different content item types
    if (item.type === 'text') {
      return item.text || '';
    } else if (item.type === 'thinking') {
      // Extract thinking content
      return item.thinking || '';
    } else if (item.type === 'tool_use') {
      // Summarize tool use without the full input details
      const toolName = item.name || 'unknown';
      const toolId = item.id || '';
      return `[Tool: ${toolName}${toolId ? ` (${toolId})` : ''}]`;
    } else if (item.type === 'tool_result') {
      // Check size before extracting
      const contentSize = this.getToolResultSize(item);
      if (contentSize > 1024 * 1024) { // 1MB threshold
        const sizeMB = Math.round(contentSize / (1024 * 1024) * 10) / 10;
        return `[FILTERED: Large tool result ~${sizeMB}MB - tool output to assistant]`;
      }
      return this.extractToolResultFromItem(item);
    } else {
      // Fallback for other content types - be more thorough
      return item.text || item.content || item.thinking || JSON.stringify(item);
    }
  }

  /**
   * Calculate the size of tool_result content
   */
  private getToolResultSize(item: any): number {
    if (!item.content) return 0;
    
    if (Array.isArray(item.content)) {
      return item.content.reduce((size: number, contentItem: any) => {
        return size + (contentItem.text_length || contentItem.text?.length || contentItem.content?.length || 0);
      }, 0);
    }
    
    if (typeof item.content === 'string') {
      return item.content.length;
    }
    
    return JSON.stringify(item.content).length;
  }

  /**
   * Extracts content from tool_result messages with large content filtering
   */
  private extractToolResultContent(m: TranscriptMessage): string {
    const LARGE_CONTENT_THRESHOLD = 1024 * 1024; // 1MB threshold
    
    // Check if this is a large tool_result that should be filtered
    if (m.content && Array.isArray(m.content)) {
      const totalSize = m.content.reduce((size: number, contentItem: any) => {
        return size + (contentItem.text_length || contentItem.text?.length || 0);
      }, 0);
      
      if (totalSize > LARGE_CONTENT_THRESHOLD) {
        const sizeMB = Math.round(totalSize / (1024 * 1024) * 10) / 10;
        return `[FILTERED: Large tool result ~${sizeMB}MB - tool output to assistant]`;
      }
      
      // Normal size array - extract all content items
      return m.content.map((item: any) => this.extractToolResultFromItem(item)).filter(Boolean).join(' ');
    }
    
    // Check if direct content property is too large
    if (m.content && typeof m.content === 'string' && m.content.length > LARGE_CONTENT_THRESHOLD) {
      const sizeMB = Math.round(m.content.length / (1024 * 1024) * 10) / 10;
      return `[FILTERED: Large tool result ~${sizeMB}MB - tool output to assistant]`;
    }
    
    // Content is not too large, extract normally
    return this.extractToolResultFromItem(m);
  }

  /**
   * Extracts content from tool_result item (normal size)
   */
  private extractToolResultFromItem(item: any): string {
    // Handle content items within an array (for individual array elements)
    if (item.type === 'text' && item.text) {
      return item.text;
    }
    
    // Handle when passed the full message/item with content property
    if (!item.content) {
      return '[Tool result: no content]';
    }
    
    // Handle array content
    if (Array.isArray(item.content)) {
      return item.content
        .map((contentItem: any) => {
          if (contentItem.type === 'text' && contentItem.text) {
            return contentItem.text;
          }
          return contentItem.text || contentItem.content || '';
        })
        .filter(Boolean)
        .join(' ');
    }
    
    // Handle string content
    if (typeof item.content === 'string') {
      return item.content;
    }
    
    // Handle object content
    if (typeof item.content === 'object') {
      return item.content.text || item.content.content || '[Tool result: complex object]';
    }
    
    return String(item.content || '');
  }

  // Removed filterLargeContent method - content filtering now handled at message level in extractContent

  // </Block> =======================================

  /**
   * Creates a clear message flow label that eliminates confusion about content direction
   */
  private createMessageFlowLabel(m: TranscriptMessage, messageNumber: number): string {
    // Check if this message contains tool results
    const containsToolResult = this.messageContainsToolResult(m);
    
    if (containsToolResult) {
      // This is a tool result being passed to the assistant
      return `Message ${messageNumber} (tool → assistant)`;
    }
    
    // Handle different message types with clear flow direction
    switch (m.type) {
      case 'user':
        return `Message ${messageNumber} (user → assistant)`;
      case 'assistant':
        return `Message ${messageNumber} (assistant → user)`;
      case 'system':
        return `Message ${messageNumber} (system)`;
      case 'tool_result':
        return `Message ${messageNumber} (tool → assistant)`;
      case 'summary':
        return `Message ${messageNumber} (session summary)`;
      case 'result':
        if (m.subtype === 'success') {
          return `Message ${messageNumber} (session result)`;
        } else if (m.subtype === 'error_max_turns') {
          return `Message ${messageNumber} (session error: max turns)`;
        } else if (m.subtype === 'error_during_execution') {
          return `Message ${messageNumber} (session error: execution)`;
        }
        return `Message ${messageNumber} (session result)`;
      default:
        return `Message ${messageNumber} (${m.type})`;
    }
  }
  
  /**
   * Checks if a message contains tool result content
   */
  private messageContainsToolResult(m: TranscriptMessage): boolean {
    // Check if this is a user message containing tool_result content items
    if (m.type === 'user' && m.message?.content && Array.isArray(m.message.content)) {
      return m.message.content.some((item: any) => item.type === 'tool_result');
    }
    
    // Check if this is a direct tool_result message
    if (m.type === 'tool_result') {
      return true;
    }
    
    // Check if content array contains tool_result items
    if (m.content && Array.isArray(m.content)) {
      return m.content.some((item: any) => item.type === 'tool_result');
    }
    
    return false;
  }

  /**
   * Debug method to show filtered output without full compression
   * Now supports automatic chunking for large outputs
   */
  public showFilteredOutput(transcriptPath: string, enableChunking: boolean = true): void {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    const messages: TranscriptMessage[] = [];

    // Parse all messages (not just first 20)
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        messages.push(parsed);
      } catch (e) {
        continue;
      }
    }

    const outputLines: string[] = [];
    
    // Get first and last timestamps for the whole transcript
    const firstTimestamp = messages.length > 0 ? this.normalizeTimestamp(messages[0]) : '';
    const lastTimestamp = messages.length > 0 ? this.normalizeTimestamp(messages[messages.length - 1]) : '';
    
    messages.forEach((m, index) => {
      const filteredContent = this.extractContent(m);
      
      // Keep on single line but preserve line breaks as \n
      const singleLine = filteredContent.replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/\r/g, '\\n');
      
      // Format: "- content"
      outputLines.push(`- ${singleLine}`);
    });

    const fullOutput = outputLines.join('\n');
    const baseOutputFile = `/tmp/filtered-transcript-${Date.now()}`;

    // Check if chunking is needed
    if (enableChunking && this.chunkManager.needsChunking(fullOutput)) {
      console.log('\n📦 Large transcript detected, chunking output...');
      
      const chunks = this.chunkManager.chunkTranscript(fullOutput);
      console.log(this.chunkManager.getChunkingStats(chunks));
      
      // Save each chunk to a separate file with timestamps
      chunks.forEach((chunk, index) => {
        const chunkFile = `${baseOutputFile}-chunk-${index + 1}.txt`;
        
        // Calculate timestamps for this chunk
        const chunkFirstIdx = chunk.metadata.startIndex;
        const chunkLastIdx = Math.min(chunk.metadata.endIndex, messages.length - 1);
        const chunkFirstTime = messages[chunkFirstIdx] ? this.normalizeTimestamp(messages[chunkFirstIdx]) : '';
        const chunkLastTime = messages[chunkLastIdx] ? this.normalizeTimestamp(messages[chunkLastIdx]) : '';
        
        // Add timestamps to metadata
        chunk.metadata.firstTimestamp = chunkFirstTime;
        chunk.metadata.lastTimestamp = chunkLastTime;
        
        const chunkContent = this.chunkManager.createChunkHeader(chunk.metadata) + chunk.content;
        fs.writeFileSync(chunkFile, chunkContent, 'utf-8');
        console.log(`  ✅ Chunk ${index + 1}/${chunks.length} saved to: ${chunkFile}`);
      });
      console.log(`Processed ${messages.length} messages from transcript into ${chunks.length} chunks`);
      console.log(`📅 Time range: ${firstTimestamp} to ${lastTimestamp}`);
    } else {
      // Save as single file if no chunking needed
      const outputFile = `${baseOutputFile}.txt`;
      
      // Add timestamps at the beginning of the file
      const outputWithTimestamps = `# ${firstTimestamp} to ${lastTimestamp}\n${fullOutput}`;
      
      fs.writeFileSync(outputFile, outputWithTimestamps, 'utf-8');
      console.log(`\nFiltered output saved to: ${outputFile}`);
      console.log(`Processed ${messages.length} messages from transcript`);
      console.log(`📅 Time range: ${firstTimestamp} to ${lastTimestamp}`);
    }
  }

  /**
   * Summarizes tool use results
   */
  private summarizeToolResult(toolResult: any, existingContent: string): string {
    const summaryParts: string[] = [];

    if (toolResult.stdout) {
      const stdout = String(toolResult.stdout);
      if (stdout.length > 200) {
        const lineCount = stdout.split('\n').length;
        const charCount = stdout.length;
        const lines = stdout.split('\n');
        const preview = lines.slice(0, 3).join('\n');
        const suffix = lines.length > 6 ? `\n...\n${lines.slice(-2).join('\n')}` : '';
        summaryParts.push(`Result: ${preview}${suffix} (${lineCount} lines, ${charCount} chars)`);
      } else {
        summaryParts.push(`Result: ${stdout}`);
      }
    }

    if (toolResult.stderr && toolResult.stderr.trim()) {
      summaryParts.push(`Error: ${toolResult.stderr}`);
    }

    if (toolResult.interrupted) {
      summaryParts.push('(interrupted)');
    }

    if (toolResult.isImage) {
      summaryParts.push('(image output)');
    }

    return summaryParts.join('\n');
  }

  /**
   * Normalizes timestamp formats
   */
  private normalizeTimestamp(m: TranscriptMessage): string {
    const ts = m.timestamp || m.message?.timestamp || m.created_at || m.message?.created_at;
    if (!ts) return '';

    try {
      const date = new Date(ts);
      if (isNaN(date.getTime())) return '';
      return date.toISOString().replace('T', ' ');
    } catch (e) {
      log.debug(`Invalid timestamp format: ${ts}`);
      return '';
    }
  }

  // <Block> 1.8 ====================================
  // Archive Creation - Natural flow (9/10)
  /**
   * Creates an archive file of the original transcript
   */
  private createArchive(transcriptPath: string, projectPrefix: string, sessionId: string, content: string): string {
    const projectArchiveDir = this.paths.getProjectArchiveDir(projectPrefix);
    PathResolver.ensureDirectory(projectArchiveDir);

    const archivePath = join(projectArchiveDir, `${sessionId}.jsonl.archive`);
    fs.writeFileSync(archivePath, content);

    log.debug(`📦 Created archive: ${archivePath}`);

    return archivePath;
  }
  // </Block> =======================================

  /**
   * Stores summaries using the configured storage provider (SQLite or JSONL fallback)
   * Each record is stored with proper type information for easy querying
   */
  private async appendToIndex(summaries: any[], overview: string | null, projectPrefix: string, sessionId: string, messages: TranscriptMessage[], archivePath: string, timestamp: string): Promise<void> {
    try {
      // Check if migration is needed and log warning
      if (await needsMigration()) {
        this.debugLog('⚠️ JSONL to SQLite migration recommended. Run: claude-mem migrate-index');
      }

      const storage = await getStorageProvider();
      this.debugLog(`💾 Using ${storage.backend} storage backend`);

      // Create or ensure session exists
      const sessionInput: SessionInput = {
        session_id: sessionId,
        project: projectPrefix,
        created_at: timestamp,
        source: 'compress',
        archive_path: archivePath,
        archive_bytes: fs.statSync(archivePath).size,
        archived_at: new Date().toISOString()
      };

      // Check if session already exists (for duplicate prevention)
      if (!await storage.hasSession(sessionId)) {
        await storage.createSession(sessionInput);
        this.debugLog(`📋 Created session record: ${sessionId}`);
      } else {
        this.debugLog(`📋 Session already exists: ${sessionId}`);
      }

      // Add overview if present
      if (overview) {
        const overviewInput: OverviewInput = {
          session_id: sessionId,
          content: overview,
          created_at: timestamp,
          project: projectPrefix,
          origin: 'claude'
        };
        await storage.upsertOverview(overviewInput);
        this.debugLog(`📝 Stored overview for session: ${sessionId}`);
      }

      // If no summaries from Claude, write diagnostic info
      if (!summaries || summaries.length === 0) {
        log.debug('📝 No summaries extracted from JSON response');
        
        const diagnosticInput: DiagnosticInput = {
          session_id: sessionId,
          message: "NO SUMMARIES EXTRACTED - Check logs for valid JSON response",
          severity: 'warn',
          created_at: timestamp,
          project: projectPrefix,
          origin: 'compressor'
        };
        
        await storage.createDiagnostic(diagnosticInput);
        this.debugLog(`⚠️ No summaries for session ${sessionId} - Check if Claude returned valid JSON in <JSONResponse> tags`);
      } else {
        // Prepare memory records for bulk insertion
        const memoryInputs: MemoryInput[] = summaries.map((summary) => ({
          session_id: sessionId,
          text: summary.text || '',
          document_id: summary.document_id,
          keywords: summary.keywords,
          created_at: summary.timestamp || timestamp,
          project: projectPrefix,
          archive_basename: path.basename(archivePath),
          origin: 'transcript'
        }));

        // Store memories using bulk operation if available, otherwise one by one
        await storage.createMemories(memoryInputs);

        log.debug(`📝 Stored ${summaries.length} summaries using ${storage.backend}`);
        this.debugLog(`💾 Stored ${summaries.length} memories for session: ${sessionId}`);
      }
      
    } catch (error) {
      // If storage fails, fall back to JSONL as emergency backup
      this.debugLog(`❌ Storage failed, falling back to JSONL: ${error}`);
      log.warn('Storage provider failed, falling back to JSONL', error);
      
      // Emergency JSONL fallback
      this.appendToIndexJSONL(summaries, overview, projectPrefix, sessionId, messages, archivePath, timestamp);
    }
  }

  /**
   * Emergency fallback method using original JSONL approach
   */
  private appendToIndexJSONL(summaries: any[], overview: string | null, projectPrefix: string, sessionId: string, messages: TranscriptMessage[], archivePath: string, timestamp: string): void {
    // Use PathResolver's getIndexPath() for consistency
    const indexPath = this.paths.getIndexPath();
    const indexDir = this.paths.getConfigDir();
    PathResolver.ensureDirectory(indexDir);

    // Write session header as JSON object
    const sessionHeader = {
      type: "session",
      session_id: sessionId,
      timestamp: timestamp,
      project: projectPrefix
    };
    fs.appendFileSync(indexPath, JSON.stringify(sessionHeader) + '\n');
    
    // Add overview as JSON object if present
    if (overview) {
      const overviewObj = {
        type: "overview",
        content: overview,
        session_id: sessionId,
        project: projectPrefix,
        timestamp: timestamp
      };
      fs.appendFileSync(indexPath, JSON.stringify(overviewObj) + '\n');
    }

    // If no summaries from Claude, write diagnostic info
    if (!summaries || summaries.length === 0) {
      log.debug('📝 No summaries extracted from JSON response');
      const diagnosticObj = {
        type: "diagnostic",
        message: "NO SUMMARIES EXTRACTED - Check logs for valid JSON response",
        session_id: sessionId,
        project: projectPrefix,
        timestamp: timestamp
      };
      fs.appendFileSync(indexPath, JSON.stringify(diagnosticObj) + '\n');
      this.debugLog(`⚠️ No summaries for session ${sessionId} - Check if Claude returned valid JSON in <JSONResponse> tags`);
    } else {
      // Write each summary as JSONL memory object
      summaries.forEach((summary) => {
        const memoryObj = {
          type: "memory",
          text: summary.text,
          document_id: summary.document_id,
          keywords: summary.keywords,
          session_id: sessionId,
          project: projectPrefix,
          timestamp: summary.timestamp || timestamp,
          archive: path.basename(archivePath)
        };
        fs.appendFileSync(indexPath, JSON.stringify(memoryObj) + '\n');
      });

      log.debug(`📝 Appended ${summaries.length} summaries to index as JSONL`);
    }
    
    log.debug(`Index path: ${indexPath}`);
  }
}