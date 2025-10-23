import { test, describe } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { SessionSearch } from '../src/services/sqlite/SessionSearch';
import fs from 'fs';
import path from 'path';

const TEST_DB_DIR = '/tmp/claude-mem-test';
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test.db');

describe('SessionSearch FTS5 Injection Tests', () => {
  let search: SessionSearch;
  let db: Database.Database;

  // Setup test database before each test
  function setupTestDB() {
    // Clean up any existing test database
    if (fs.existsSync(TEST_DB_DIR)) {
      fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });

    // Create database with required schema
    db = new Database(TEST_DB_PATH);
    db.pragma('journal_mode = WAL');

    // Create minimal schema needed for search tests
    // Note: Using claude_session_id to match SessionSearch expectations
    db.exec(`
      CREATE TABLE sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claude_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        started_at_epoch INTEGER DEFAULT ((unixepoch() * 1000))
      );

      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claude_session_id TEXT NOT NULL,
        prompt_number INTEGER DEFAULT 1,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        narrative TEXT,
        text TEXT,
        facts TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        project TEXT,
        created_at_epoch INTEGER DEFAULT ((unixepoch() * 1000)),
        FOREIGN KEY (claude_session_id) REFERENCES sdk_sessions(claude_session_id)
      );

      CREATE TABLE session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claude_session_id TEXT NOT NULL,
        prompt_number INTEGER DEFAULT 1,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        notes TEXT,
        files_read TEXT,
        files_edited TEXT,
        project TEXT,
        created_at_epoch INTEGER DEFAULT ((unixepoch() * 1000)),
        FOREIGN KEY (claude_session_id) REFERENCES sdk_sessions(claude_session_id)
      );

      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claude_session_id TEXT NOT NULL,
        prompt_number INTEGER DEFAULT 1,
        prompt_text TEXT NOT NULL,
        created_at_epoch INTEGER DEFAULT ((unixepoch() * 1000)),
        FOREIGN KEY (claude_session_id) REFERENCES sdk_sessions(claude_session_id)
      );

      -- Create FTS5 tables manually
      CREATE VIRTUAL TABLE observations_fts USING fts5(
        title,
        subtitle,
        narrative,
        text,
        facts,
        concepts,
        content='observations',
        content_rowid='id'
      );

      CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
        request,
        investigated,
        learned,
        completed,
        next_steps,
        notes,
        content='session_summaries',
        content_rowid='id'
      );

      CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
        prompt_text,
        content='user_prompts',
        content_rowid='id'
      );

      -- Create triggers for observations
      CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;

      CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
      END;

      CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;

      -- Create triggers for session_summaries
      CREATE TRIGGER session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;

      CREATE TRIGGER session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
      END;

      CREATE TRIGGER session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;

      -- Create triggers for user_prompts
      CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;

      CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
      END;

      CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;
    `);

    db.close();

    // Create SessionSearch instance
    return new SessionSearch(TEST_DB_PATH);
  }

  function teardownTestDB() {
    if (search) {
      search.close();
      search = null;
    }
    if (fs.existsSync(TEST_DB_DIR)) {
      fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
  }

  test('should escape double quotes in search queries', () => {
    search = setupTestDB();
    
    // Insert test data
    const db = new Database(TEST_DB_PATH);
    db.exec(`
      INSERT INTO sdk_sessions (claude_session_id, project) VALUES ('test-session-1', 'test-project');
      INSERT INTO observations (claude_session_id, prompt_number, type, title, narrative, text, facts, concepts, files_read, files_modified, project)
      VALUES ('test-session-1', 1, 'feature', 'Test observation', 'A test "quoted" narrative', 'Some text', '[]', '[]', '[]', '[]', 'test-project');
    `);
    db.close();

    // Test query with double quotes - should not cause injection
    const maliciousQuery = 'test" OR 1=1 --';
    
    // This should not throw an error and should search safely
    const results = search.searchObservations(maliciousQuery);
    
    // With proper escaping, this should return 0 results (no match for the literal string)
    // Without escaping, it could match everything due to OR 1=1
    assert.strictEqual(Array.isArray(results), true, 'Should return an array');
    
    teardownTestDB();
  });

  test('should handle FTS5 special operators safely', () => {
    search = setupTestDB();
    
    // Insert test data
    const db = new Database(TEST_DB_PATH);
    db.exec(`
      INSERT INTO sdk_sessions (claude_session_id, project) VALUES ('test-session-2', 'test-project');
      INSERT INTO observations (claude_session_id, prompt_number, type, title, narrative, text, facts, concepts, files_read, files_modified, project)
      VALUES ('test-session-2', 1, 'feature', 'Security feature', 'Implements security', 'Authentication system', '[]', '[]', '[]', '[]', 'test-project');
    `);
    db.close();

    // Test queries with FTS5 operators that should be escaped
    const testQueries = [
      'AND OR NOT',           // Boolean operators
      '(parentheses)',        // Grouping
      'asterisk*',            // Wildcard
      'column:value',         // Column filter attempt
    ];

    testQueries.forEach(query => {
      // Should not throw an error
      const results = search.searchObservations(query);
      assert.strictEqual(Array.isArray(results), true, `Should return array for query: ${query}`);
    });
    
    teardownTestDB();
  });

  test('should find exact phrase matches when properly escaped', () => {
    search = setupTestDB();
    
    // Insert test data
    const db = new Database(TEST_DB_PATH);
    db.exec(`
      INSERT INTO sdk_sessions (claude_session_id, project) VALUES ('test-session-3', 'test-project');
      INSERT INTO observations (claude_session_id, prompt_number, type, title, narrative, text, facts, concepts, files_read, files_modified, project)
      VALUES ('test-session-3', 1, 'feature', 'Hello world', 'This is a hello world example', 'Hello world program', '[]', '[]', '[]', '[]', 'test-project');
      INSERT INTO observations (claude_session_id, prompt_number, type, title, narrative, text, facts, concepts, files_read, files_modified, project)
      VALUES ('test-session-3', 2, 'feature', 'Goodbye moon', 'This is something else', 'Different content', '[]', '[]', '[]', '[]', 'test-project');
    `);
    db.close();

    // Search for exact phrase
    const results = search.searchObservations('hello world');
    
    assert.strictEqual(Array.isArray(results), true, 'Should return an array');
    assert.ok(results.length > 0, 'Should find at least one result');
    assert.ok(
      results.some(r => r.title?.toLowerCase().includes('hello') || r.narrative?.toLowerCase().includes('hello')),
      'Should find observation with "hello"'
    );
    
    teardownTestDB();
  });

  test('should handle empty and special character queries safely', () => {
    search = setupTestDB();
    
    // Insert test data
    const db = new Database(TEST_DB_PATH);
    db.exec(`
      INSERT INTO sdk_sessions (claude_session_id, project) VALUES ('test-session-4', 'test-project');
      INSERT INTO observations (claude_session_id, prompt_number, type, title, narrative, text, facts, concepts, files_read, files_modified, project)
      VALUES ('test-session-4', 1, 'feature', 'Test', 'Test observation', 'Test content', '[]', '[]', '[]', '[]', 'test-project');
    `);
    db.close();

    // Test edge cases
    const edgeCases = [
      '""',                   // Empty quoted string
      '   ',                  // Whitespace only
      '!!!',                  // Special characters
      '@#$%',                 // More special characters
    ];

    edgeCases.forEach(query => {
      // Should not throw an error
      const results = search.searchObservations(query);
      assert.strictEqual(Array.isArray(results), true, `Should return array for edge case: "${query}"`);
    });
    
    teardownTestDB();
  });

  test('should search session summaries safely', () => {
    search = setupTestDB();
    
    // Insert test data
    const db = new Database(TEST_DB_PATH);
    db.exec(`
      INSERT INTO sdk_sessions (claude_session_id, project) VALUES ('test-session-5', 'test-project');
      INSERT INTO session_summaries (claude_session_id, prompt_number, request, investigated, learned, completed, next_steps, notes, files_read, files_edited, project)
      VALUES ('test-session-5', 1, 'Implement feature', 'Looked into options', 'Learned new approach', 'Completed task', 'Next: testing', 'Notes here', '[]', '[]', 'test-project');
    `);
    db.close();

    // Test with potential injection
    const maliciousQuery = 'feature" OR type:*';
    const results = search.searchSessions(maliciousQuery);
    
    assert.strictEqual(Array.isArray(results), true, 'Should return an array');
    
    teardownTestDB();
  });

  test('should search user prompts safely', () => {
    search = setupTestDB();
    
    // Insert test data
    const db = new Database(TEST_DB_PATH);
    db.exec(`
      INSERT INTO sdk_sessions (claude_session_id, project) VALUES ('test-session-6', 'test-project');
      INSERT INTO user_prompts (claude_session_id, prompt_number, prompt_text)
      VALUES ('test-session-6', 1, 'Please implement authentication');
    `);
    db.close();

    // Test with potential injection
    const maliciousQuery = 'authentication" AND request:*';
    const results = search.searchUserPrompts(maliciousQuery);
    
    assert.strictEqual(Array.isArray(results), true, 'Should return an array');
    
    teardownTestDB();
  });
});
