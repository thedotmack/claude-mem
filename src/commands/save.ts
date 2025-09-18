import { OptionValues } from 'commander';
import { appendFileSync } from 'fs';
import { PathDiscovery } from '../services/path-discovery.js';
import { getStorageProvider, needsMigration } from '../shared/storage.js';

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
 * Save command - stores a message using the configured storage provider
 */
export async function save(message: string, options: OptionValues = {}): Promise<void> {
  // Debug: Log what we receive
  appendFileSync('/Users/alexnewman/.claude-mem/save-debug.log',
    `[${new Date().toISOString()}] Received message: "${message}" (type: ${typeof message}, length: ${message?.length})\n`,
    'utf8');

  if (!message || message.trim() === '') {
    console.error('Error: Message is required');
    process.exit(1);
  }

  const timestamp = new Date().toISOString();
  const projectName = PathDiscovery.getCurrentProjectName();
  const sessionId = generateSessionId(message);
  const documentId = `${projectName}_${sessionId}_overview`;

  try {
    // Check if migration is needed
    if (await needsMigration()) {
      console.warn('⚠️  JSONL to SQLite migration recommended. Run: claude-mem migrate-index');
    }

    // Get storage provider (SQLite preferred, JSONL fallback)
    const storage = await getStorageProvider();

    // Ensure session exists or create it
    if (!await storage.hasSession(sessionId)) {
      await storage.createSession({
        session_id: sessionId,
        project: projectName,
        created_at: timestamp,
        source: 'save'
      });
    }

    // Upsert the overview
    await storage.upsertOverview({
      session_id: sessionId,
      content: message,
      created_at: timestamp,
      project: projectName,
      origin: 'manual'
    });

    // Return JSON response for hook compatibility
    console.log(JSON.stringify({
      success: true,
      document_id: documentId,
      session_id: sessionId,
      project: projectName,
      timestamp: timestamp,
      backend: storage.backend,
      suppressOutput: true
    }));
    
  } catch (error) {
    console.error('Error saving message:', error);
    process.exit(1);
  }
}
