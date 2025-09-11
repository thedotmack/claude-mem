import { OptionValues } from 'commander';
import { appendFileSync } from 'fs';
import { PathDiscovery } from '../services/path-discovery.js';

/**
 * Generates a descriptive session ID from the message content
 * Takes first few meaningful words and creates a readable identifier
 */
function generateSessionId(message: string): string {
  // Remove punctuation and split into words
  const words = message
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2); // Skip short words like 'a', 'is', 'to'
  
  // Take first 3-4 meaningful words, max 30 chars
  const sessionWords = words.slice(0, 4).join('-');
  const truncated = sessionWords.length > 30 ? sessionWords.substring(0, 27) + '...' : sessionWords;
  
  // Add timestamp suffix to ensure uniqueness
  const timestamp = new Date().toISOString().substring(11, 19).replace(/:/g, '');
  
  return `${truncated}-${timestamp}`;
}

/**
 * Save command - stores a message to both Chroma collection and JSONL index
 */
export async function save(message: string, options: OptionValues = {}): Promise<void> {
  if (!message || message.trim() === '') {
    console.error('Error: Message is required');
    process.exit(1);
  }

  const pathDiscovery = PathDiscovery.getInstance();
  const timestamp = new Date().toISOString();
  const projectName = PathDiscovery.getCurrentProjectName();
  const sessionId = generateSessionId(message);
  const documentId = `${projectName}_${sessionId}_overview`;

  // 1. Save to Chroma collection (skip for now - MCP tools only available in Claude Code context)
  // TODO: Add Chroma integration when called from Claude Code with MCP server running

  // 2. Append to JSONL index file
  const indexPath = pathDiscovery.getIndexPath();
  const indexEntry = {
    type: "overview",
    content: message,
    session_id: sessionId,
    project: projectName,
    timestamp: timestamp
  };

  // Ensure the directory exists
  pathDiscovery.ensureDirectory(pathDiscovery.getDataDirectory());
  
  // Append to JSONL file
  appendFileSync(indexPath, JSON.stringify(indexEntry) + '\n', 'utf8');

  // 3. Return JSON response for hook compatibility
  console.log(JSON.stringify({
    success: true,
    document_id: documentId,
    session_id: sessionId,
    project: projectName,
    timestamp: timestamp,
    suppressOutput: true
  }));
}