/**
 * MySQL Types
 *
 * Re-export SQLite types with MySQL-specific additions.
 * MySQL-compatible type definitions for database operations.
 */

// Re-export all SQLite types for compatibility
export * from '../../services/sqlite/types.js';

/**
 * MySQL-specific column info result
 */
export interface MySQLColumnInfo {
  Field: string;
  Type: string;
  Null: string;
  Key: string;
  Default: string | null;
  Extra: string;
}

/**
 * MySQL index info result
 */
export interface MySQLIndexInfo {
  Table: string;
  Non_unique: number;
  Key_name: string;
  Seq_in_index: number;
  Column_name: string;
  Collation: string;
  Cardinality: number;
  Sub_part: number | null;
  Packed: string | null;
  Null: string;
  Index_type: string;
  Comment: string;
  Index_comment: string;
}