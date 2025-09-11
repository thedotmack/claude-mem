import fs from 'fs';
import path from 'path';
import { log } from '../shared/logger.js';
import { PathDiscovery } from './path-discovery.js';

/**
 * Interface for Claude Code JSONL conversation entries
 */
export interface ClaudeCodeMessage {
  sessionId: string;
  timestamp: string;
  gitBranch?: string;
  cwd: string;
  type: 'user' | 'assistant' | 'system' | 'result';
  message: {
    role: string;
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
    }> | string;
  };
  uuid: string;
  version?: string;
  isSidechain?: boolean;
  userType?: string;
  parentUuid?: string;
  subtype?: string;
  model?: string;
  stop_reason?: string;
  usage?: any;
}

/**
 * Interface matching TranscriptCompressor's expected format
 */
export interface TranscriptMessage {
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
  timestamp?: string;
  created_at?: string;
  subtype?: string;
}

/**
 * Parsed conversation with metadata
 */
export interface ParsedConversation {
  sessionId: string;
  filePath: string;
  messageCount: number;
  timestamp: string;
  gitBranch?: string;
  cwd: string;
  messages: TranscriptMessage[];
}

/**
 * Service for parsing Claude Code JSONL conversation files
 */
export class TranscriptParser {
  
  /**
   * Parse a single JSONL conversation file
   */
  async parseConversation(filePath: string): Promise<ParsedConversation> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    const claudeMessages: ClaudeCodeMessage[] = [];
    let parseErrors = 0;
    
    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        claudeMessages.push(parsed);
      } catch (e) {
        parseErrors++;
        log.debug(`Parse error on line ${i + 1}: ${(e as Error).message}`);
      }
    }
    
    if (claudeMessages.length === 0) {
      throw new Error(`No valid messages found in ${filePath}`);
    }
    
    // Get metadata from first message
    const firstMessage = claudeMessages[0];
    const sessionId = firstMessage.sessionId;
    const timestamp = firstMessage.timestamp;
    const gitBranch = firstMessage.gitBranch;
    const cwd = firstMessage.cwd;
    
    // Convert to TranscriptMessage format
    const messages = claudeMessages.map(msg => this.convertMessage(msg));
    
    log.debug(`Parsed ${filePath}: ${messages.length} messages, ${parseErrors} errors`);
    
    return {
      sessionId,
      filePath,
      messageCount: messages.length,
      timestamp,
      gitBranch,
      cwd,
      messages
    };
  }
  
  /**
   * Convert ClaudeCodeMessage to TranscriptMessage format
   */
  private convertMessage(claudeMsg: ClaudeCodeMessage): TranscriptMessage {
    const converted: TranscriptMessage = {
      type: claudeMsg.type,
      uuid: claudeMsg.uuid,
      session_id: claudeMsg.sessionId,
      timestamp: claudeMsg.timestamp,
      subtype: claudeMsg.subtype
    };
    
    // Handle message content
    if (claudeMsg.message) {
      converted.message = {
        role: claudeMsg.message.role,
        timestamp: claudeMsg.timestamp
      };
      
      if (Array.isArray(claudeMsg.message.content)) {
        // Convert content array to expected format
        converted.message.content = claudeMsg.message.content.map(item => ({
          text: item.text || item.thinking || '',
          content: item.text || item.thinking || ''
        }));
      } else if (typeof claudeMsg.message.content === 'string') {
        converted.message.content = claudeMsg.message.content;
      }
    }
    
    return converted;
  }
  
  /**
   * Scan Claude projects directory for conversation files
   */
  async scanConversationFiles(): Promise<string[]> {
    const pathDiscovery = PathDiscovery.getInstance();
    const claudeDir = path.join(pathDiscovery.getClaudeConfigDirectory(), 'projects');
    
    if (!fs.existsSync(claudeDir)) {
      return [];
    }
    
    const projectDirs = fs.readdirSync(claudeDir);
    const conversationFiles: string[] = [];
    
    for (const projectDir of projectDirs) {
      const projectPath = path.join(claudeDir, projectDir);
      if (!fs.statSync(projectPath).isDirectory()) continue;
      
      const files = fs.readdirSync(projectPath);
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          conversationFiles.push(path.join(projectPath, file));
        }
      }
    }
    
    return conversationFiles;
  }
  
  /**
   * Get conversation metadata without fully parsing
   */
  async getConversationMetadata(filePath: string): Promise<{
    sessionId: string;
    timestamp: string;
    messageCount: number;
    gitBranch?: string;
    cwd: string;
    fileSize: number;
  }> {
    const stats = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    let firstMessage;
    try {
      firstMessage = JSON.parse(lines[0]);
    } catch (e) {
      throw new Error(`Invalid JSONL format in ${filePath}`);
    }
    
    return {
      sessionId: firstMessage.sessionId,
      timestamp: firstMessage.timestamp,
      messageCount: lines.length,
      gitBranch: firstMessage.gitBranch,
      cwd: firstMessage.cwd,
      fileSize: stats.size
    };
  }
}