/**
 * MySQL Database Connection Manager
 *
 * Uses mysql2/promise for async operations.
 * Provides connection pooling for better performance.
 */

import mysql, { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

export interface MySQLConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
}

/**
 * Get MySQL configuration from environment variables or settings.
 *
 * Priority: environment variables > settings.json > defaults
 */
export function getMySQLConfig(): MySQLConfig {
  // Load settings with full priority chain: env > settings file > defaults
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  return {
    host: settings.CLAUDE_MEM_MYSQL_HOST,
    port: parseInt(settings.CLAUDE_MEM_MYSQL_PORT, 10) || 3306,
    user: settings.CLAUDE_MEM_MYSQL_USER,
    password: settings.CLAUDE_MEM_MYSQL_PASSWORD,
    database: settings.CLAUDE_MEM_MYSQL_DATABASE,
    connectionLimit: parseInt(settings.CLAUDE_MEM_MYSQL_POOL_SIZE, 10) || 10,
  };
}

/**
 * MySQL Connection Pool Wrapper
 *
 * Provides a compatible interface with bun:sqlite Database class
 * for seamless integration with existing code.
 *
 * MEMORY OPTIMIZATION: PreparedStatement objects are cached by SQL string
 * to prevent accumulation during frequent query operations.
 */
export class MySQLDatabase {
  private pool: Pool;
  private config: MySQLConfig;
  private statementCache: Map<string, MySQLPreparedStatement> = new Map();
  private static readonly MAX_CACHE_SIZE = 100;  // Prevent unbounded cache growth

  constructor(config?: MySQLConfig) {
    this.config = config || getMySQLConfig();
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      connectionLimit: this.config.connectionLimit || 10,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      idleTimeout: 60000,  // Close idle connections after 60s
    });

    logger.info('DB', `MySQL pool created for ${this.config.host}:${this.config.port}/${this.config.database}`);
  }

  /**
   * Get a connection from the pool
   */
  async getConnection(): Promise<PoolConnection> {
    return this.pool.getConnection();
  }

  /**
   * Execute a query (compatible with bun:sqlite run())
   * For INSERT/UPDATE/DELETE operations
   */
  async run(sql: string, params?: any[]): Promise<ResultSetHeader> {
    try {
      const [result] = await this.pool.query<ResultSetHeader>(sql, params || []);
      return result;
    } catch (e: any) {
      logger.error('DB', `run() FAILED: ${e.message}`, { sql: sql.substring(0, 200), params: JSON.stringify(params)?.substring(0, 200) });
      throw e;
    }
  }

  /**
   * Execute a query and return all rows (compatible with bun:sqlite all())
   */
  async all<T = RowDataPacket>(sql: string, params?: any[]): Promise<T[]> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(sql, params || []);
      return rows as T[];
    } catch (e: any) {
      logger.error('DB', `all() FAILED: ${e.message}`, { sql: sql.substring(0, 200), params: JSON.stringify(params)?.substring(0, 200) });
      throw e;
    }
  }

  /**
   * Execute a query and return first row (compatible with bun:sqlite get())
   */
  async get<T = RowDataPacket>(sql: string, params?: any[]): Promise<T | null> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(sql, params || []);
      return rows.length > 0 ? (rows[0] as T) : null;
    } catch (e: any) {
      logger.error('DB', `get() FAILED: ${e.message}`, { sql: sql.substring(0, 200), params: JSON.stringify(params)?.substring(0, 200) });
      throw e;
    }
  }

  /**
   * Prepare a statement (returns a cached prepared statement object)
   * MEMORY FIX: Caches by SQL string to prevent object accumulation.
   * MySQL uses server-side prepared statements via execute().
   */
  prepare(sql: string): MySQLPreparedStatement {
    // Check cache first
    let stmt = this.statementCache.get(sql);
    if (stmt) {
      return stmt;
    }

    // Create new statement
    stmt = new MySQLPreparedStatement(this.pool, sql);

    // Add to cache with size limit
    if (this.statementCache.size < MySQLDatabase.MAX_CACHE_SIZE) {
      this.statementCache.set(sql, stmt);
    }

    return stmt;
  }

  /**
   * Clear the statement cache (for memory cleanup)
   */
  clearStatementCache(): void {
    this.statementCache.clear();
    logger.debug('DB', 'MySQL statement cache cleared');
  }

  /**
   * Execute raw SQL (no params) - compatibility method
   */
  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  /**
   * Begin a transaction
   */
  async beginTransaction(): Promise<PoolConnection> {
    const conn = await this.pool.getConnection();
    await conn.beginTransaction();
    return conn;
  }

  /**
   * Commit a transaction
   */
  async commit(conn: PoolConnection): Promise<void> {
    await conn.commit();
    conn.release();
  }

  /**
   * Rollback a transaction
   */
  async rollback(conn: PoolConnection): Promise<void> {
    await conn.rollback();
    conn.release();
  }

  /**
   * Create a transaction wrapper (compatible with bun:sqlite transaction())
   */
  transaction<T>(fn: (db: MySQLTransactionConnection) => T | Promise<T>): () => Promise<T> {
    return async () => {
      const conn = await this.beginTransaction();
      try {
        const txConn = new MySQLTransactionConnection(conn);
        const result = await fn(txConn);
        await this.commit(conn);
        return result;
      } catch (error) {
        await this.rollback(conn);
        throw error;
      }
    };
  }

  /**
   * Async transaction - executes the transaction immediately
   * Used by transactions.ts for atomic operations
   */
  async transactionAsync<T>(fn: (db: MySQLTransactionConnection) => T | Promise<T>): Promise<T> {
    const conn = await this.beginTransaction();
    try {
      const txConn = new MySQLTransactionConnection(conn);
      const result = await fn(txConn);
      await this.commit(conn);
      return result;
    } catch (error) {
      await this.rollback(conn);
      throw error;
    }
  }

  /**
   * Check if an index exists
   */
  async indexExists(tableName: string, indexName: string): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SHOW INDEX FROM ${tableName} WHERE Key_name = ?`,
      [indexName]
    );
    return rows.length > 0;
  }

  /**
   * Check if a column exists
   */
  async columnExists(tableName: string, columnName: string): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SHOW COLUMNS FROM ${tableName} LIKE ?`,
      [columnName]
    );
    return rows.length > 0;
  }

  /**
   * Check if a table exists
   */
  async tableExists(tableName: string): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SHOW TABLES LIKE ?`,
      [tableName]
    );
    return rows.length > 0;
  }

  /**
   * Close the pool
   */
  async close(): Promise<void> {
    // Clear statement cache first
    this.clearStatementCache();
    await this.pool.end();
    logger.info('DB', 'MySQL pool closed');
  }

  /**
   * Get the pool directly (for advanced use)
   */
  getPool(): Pool {
    return this.pool;
  }
}

/**
 * MySQL Prepared Statement
 *
 * Wrapper for server-side prepared statements
 */
export class MySQLPreparedStatement {
  private pool: Pool;
  private sql: string;

  constructor(pool: Pool, sql: string) {
    this.pool = pool;
    this.sql = sql;
  }

  async run(...params: any[]): Promise<ResultSetHeader> {
    try {
      const [result] = await this.pool.query<ResultSetHeader>(this.sql, params);
      return result;
    } catch (e: any) {
      logger.error('DB', `stmt.run() FAILED: ${e.message}`, { sql: this.sql.substring(0, 200), params: JSON.stringify(params)?.substring(0, 200) });
      throw e;
    }
  }

  async all<T = RowDataPacket>(...params: any[]): Promise<T[]> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(this.sql, params);
      return rows as T[];
    } catch (e: any) {
      logger.error('DB', `stmt.all() FAILED: ${e.message}`, { sql: this.sql.substring(0, 200), params: JSON.stringify(params)?.substring(0, 200) });
      throw e;
    }
  }

  async get<T = RowDataPacket>(...params: any[]): Promise<T | null> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(this.sql, params);
      return rows.length > 0 ? (rows[0] as T) : null;
    } catch (e: any) {
      logger.error('DB', `stmt.get() FAILED: ${e.message}`, { sql: this.sql.substring(0, 200), params: JSON.stringify(params)?.substring(0, 200) });
      throw e;
    }
  }
}

/**
 * MySQL Transaction Connection
 *
 * Wrapper for connection during transaction
 */
export class MySQLTransactionConnection {
  private conn: PoolConnection;

  constructor(conn: PoolConnection) {
    this.conn = conn;
  }

  async run(sql: string, params?: any[]): Promise<ResultSetHeader> {
    try {
      const [result] = await this.conn.query<ResultSetHeader>(sql, params || []);
      return result;
    } catch (e: any) {
      logger.error('DB', `tx.run() FAILED: ${e.message}`, { sql: sql.substring(0, 200), params: JSON.stringify(params)?.substring(0, 200) });
      throw e;
    }
  }

  async all<T = RowDataPacket>(sql: string, params?: any[]): Promise<T[]> {
    try {
      const [rows] = await this.conn.query<RowDataPacket[]>(sql, params || []);
      return rows as T[];
    } catch (e: any) {
      logger.error('DB', `tx.all() FAILED: ${e.message}`, { sql: sql.substring(0, 200), params: JSON.stringify(params)?.substring(0, 200) });
      throw e;
    }
  }

  async get<T = RowDataPacket>(sql: string, params?: any[]): Promise<T | null> {
    try {
      const [rows] = await this.conn.query<RowDataPacket[]>(sql, params || []);
      return rows.length > 0 ? (rows[0] as T) : null;
    } catch (e: any) {
      logger.error('DB', `tx.get() FAILED: ${e.message}`, { sql: sql.substring(0, 200), params: JSON.stringify(params)?.substring(0, 200) });
      throw e;
    }
  }

  prepare(sql: string): MySQLPreparedStatementTransaction {
    return new MySQLPreparedStatementTransaction(this.conn, sql);
  }
}

/**
 * MySQL Prepared Statement for Transaction
 */
export class MySQLPreparedStatementTransaction {
  private conn: PoolConnection;
  private sql: string;

  constructor(conn: PoolConnection, sql: string) {
    this.conn = conn;
    this.sql = sql;
  }

  async run(...params: any[]): Promise<ResultSetHeader> {
    try {
      const [result] = await this.conn.query<ResultSetHeader>(this.sql, params);
      return result;
    } catch (e: any) {
      logger.error('DB', `txStmt.run() FAILED: ${e.message}`, { sql: this.sql.substring(0, 200), params: JSON.stringify(params)?.substring(0, 200) });
      throw e;
    }
  }

  async all<T = RowDataPacket>(...params: any[]): Promise<T[]> {
    try {
      const [rows] = await this.conn.query<RowDataPacket[]>(this.sql, params);
      return rows as T[];
    } catch (e: any) {
      logger.error('DB', `txStmt.all() FAILED: ${e.message}`, { sql: this.sql.substring(0, 200), params: JSON.stringify(params)?.substring(0, 200) });
      throw e;
    }
  }

  async get<T = RowDataPacket>(...params: any[]): Promise<T | null> {
    try {
      const [rows] = await this.conn.query<RowDataPacket[]>(this.sql, params);
      return rows.length > 0 ? (rows[0] as T) : null;
    } catch (e: any) {
      logger.error('DB', `txStmt.get() FAILED: ${e.message}`, { sql: this.sql.substring(0, 200), params: JSON.stringify(params)?.substring(0, 200) });
      throw e;
    }
  }
}

// Export types for compatibility
export type { RowDataPacket, ResultSetHeader };