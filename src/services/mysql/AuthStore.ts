/**
 * AuthStore - Authentication database operations (MySQL)
 */

import { createHash, randomBytes } from 'crypto';
import type { MySQLDatabase } from './Database.js';
import { logger } from '../../utils/logger.js';

// Try to import bcrypt, fallback to SHA-256 if not available
let bcrypt: any = null;
try {
  bcrypt = await import('bcrypt');
} catch {
  logger.warn('AUTH', 'bcrypt not available, falling back to SHA-256 (less secure)');
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
  created_at_epoch: number;
  last_login_at: string | null;
  last_login_epoch: number | null;
}

export interface TokenRow {
  id: number;
  user_id: number;
  token: string;
  expires_at: string;
  expires_at_epoch: number;
  created_at: string;
  created_at_epoch: number;
}

/**
 * Password hash using bcrypt (preferred) or SHA-256 (fallback)
 */
export async function hashPassword(password: string): Promise<string> {
  if (bcrypt) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
  }
  // Fallback: SHA-256 with random salt
  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256')
    .update(password + salt)
    .digest('hex');
  return `sha256:${salt}:${hash}`;
}

/**
 * Verify password against stored hash
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  // Handle bcrypt format ($2a$... or $2b$...)
  if (bcrypt && (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$'))) {
    return bcrypt.compare(password, storedHash);
  }
  
  // Handle SHA-256 format (sha256:salt:hash)
  if (storedHash.startsWith('sha256:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;
    const [, salt, hash] = parts;
    const computedHash = createHash('sha256')
      .update(password + salt)
      .digest('hex');
    return computedHash === hash;
  }
  
  // Legacy format (salt:hash) - for backward compatibility
  const parts = storedHash.split(':');
  if (parts.length === 2) {
    const [salt, hash] = parts;
    const computedHash = createHash('sha256')
      .update(password + salt)
      .digest('hex');
    return computedHash === hash;
  }
  
  return false;
}

/**
 * Generate authentication token
 */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export class AuthStore {
  private db: MySQLDatabase;

  constructor(db: MySQLDatabase) {
    this.db = db;
  }

  /**
   * Find user by username
   */
  async findByUsername(username: string): Promise<UserRow | null> {
    const result = await this.db.prepare(
      'SELECT * FROM users WHERE username = ?'
    ).get(username);
    return result as UserRow | null;
  }

  /**
   * Create new user
   */
  async createUser(username: string, password: string, role: string = 'user'): Promise<number> {
    const passwordHash = await hashPassword(password);
    const now = Date.now();
    const timestampIso = new Date(now).toISOString();

    const result = await this.db.prepare(`
      INSERT INTO users (username, password_hash, role, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, passwordHash, role, timestampIso, now);

    return result.insertId;
  }

  /**
   * Update last login time
   */
  async updateLastLogin(userId: number): Promise<void> {
    const now = Date.now();
    const timestampIso = new Date(now).toISOString();

    await this.db.prepare(`
      UPDATE users SET last_login_at = ?, last_login_epoch = ? WHERE id = ?
    `).run(timestampIso, now, userId);
  }

  /**
   * Create authentication token (valid for 24 hours)
   */
  async createToken(userId: number): Promise<string> {
    const token = generateToken();
    const now = Date.now();
    const expiresAt = now + 24 * 60 * 60 * 1000; // 24 hours
    const timestampIso = new Date(now).toISOString();
    const expiresIso = new Date(expiresAt).toISOString();

    await this.db.prepare(`
      INSERT INTO auth_tokens (user_id, token, expires_at, expires_at_epoch, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, token, expiresIso, expiresAt, timestampIso, now);

    logger.info('AUTH', `Token created for user ${userId}`, { tokenPrefix: token.slice(0, 8) });
    return token;
  }

  /**
   * Validate token and return user
   */
  async validateToken(token: string): Promise<UserRow | null> {
    const now = Date.now();

    // Find valid token
    const tokenRow = await this.db.prepare(`
      SELECT t.*, u.id as user_id, u.username, u.role, u.password_hash, u.created_at, u.created_at_epoch, u.last_login_at, u.last_login_epoch
      FROM auth_tokens t
      JOIN users u ON t.user_id = u.id
      WHERE t.token = ? AND t.expires_at_epoch > ?
    `).get(token, now);

    if (!tokenRow) {
      logger.debug('AUTH', 'Token validation failed', { tokenPrefix: token.slice(0, 8) });
      return null;
    }

    return {
      id: tokenRow.user_id,
      username: tokenRow.username,
      password_hash: tokenRow.password_hash,
      role: tokenRow.role,
      created_at: tokenRow.created_at,
      created_at_epoch: tokenRow.created_at_epoch,
      last_login_at: tokenRow.last_login_at,
      last_login_epoch: tokenRow.last_login_epoch
    } as UserRow;
  }

  /**
   * Delete token (logout)
   */
  async deleteToken(token: string): Promise<void> {
    await this.db.prepare(
      'DELETE FROM auth_tokens WHERE token = ?'
    ).run(token);
    logger.info('AUTH', 'Token deleted (logout)');
  }

  /**
   * Clean up expired tokens
   */
  async cleanupExpiredTokens(): Promise<number> {
    const now = Date.now();
    const result = await this.db.prepare(
      'DELETE FROM auth_tokens WHERE expires_at_epoch < ?'
    ).run(now) as any;
    
    const changes = result.affectedRows || result.changes || 0;
    if (changes > 0) {
      logger.info('AUTH', `Cleaned up ${changes} expired tokens`);
    }
    return changes;
  }
}