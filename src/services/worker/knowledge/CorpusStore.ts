/**
 * CorpusStore - File I/O for corpus JSON files
 *
 * Manages reading, writing, listing, and deleting corpus files
 * stored in ~/.claude-mem/corpora/
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../../../utils/logger.js';
import type { CorpusFile, CorpusStats } from './types.js';

const CORPORA_DIR = path.join(os.homedir(), '.claude-mem', 'corpora');

export class CorpusStore {
  private readonly corporaDir: string;

  constructor() {
    this.corporaDir = CORPORA_DIR;
    if (!fs.existsSync(this.corporaDir)) {
      fs.mkdirSync(this.corporaDir, { recursive: true });
      logger.debug('WORKER', `Created corpora directory: ${this.corporaDir}`);
    }
  }

  /**
   * Write a corpus file to disk as {name}.corpus.json
   */
  write(corpus: CorpusFile): void {
    const filePath = this.getFilePath(corpus.name);
    fs.writeFileSync(filePath, JSON.stringify(corpus, null, 2), 'utf-8');
    logger.debug('WORKER', `Wrote corpus file: ${filePath} (${corpus.observations.length} observations)`);
  }

  /**
   * Read a corpus file by name, return null if not found
   */
  read(name: string): CorpusFile | null {
    const filePath = this.getFilePath(name);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as CorpusFile;
    } catch (error) {
      logger.error('WORKER', `Failed to read corpus file: ${filePath}`, { error });
      return null;
    }
  }

  /**
   * List all corpora metadata (reads each file but omits observations for efficiency)
   */
  list(): Array<{ name: string; description: string; stats: CorpusStats; session_id: string | null }> {
    if (!fs.existsSync(this.corporaDir)) {
      return [];
    }

    const files = fs.readdirSync(this.corporaDir).filter(f => f.endsWith('.corpus.json'));
    const results: Array<{ name: string; description: string; stats: CorpusStats; session_id: string | null }> = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.corporaDir, file), 'utf-8');
        const corpus = JSON.parse(raw) as CorpusFile;
        results.push({
          name: corpus.name,
          description: corpus.description,
          stats: corpus.stats,
          session_id: corpus.session_id,
        });
      } catch (error) {
        logger.error('WORKER', `Failed to parse corpus file: ${file}`, { error });
      }
    }

    return results;
  }

  /**
   * Delete a corpus file, return true if it existed
   */
  delete(name: string): boolean {
    const filePath = this.getFilePath(name);
    if (!fs.existsSync(filePath)) {
      return false;
    }

    fs.unlinkSync(filePath);
    logger.debug('WORKER', `Deleted corpus file: ${filePath}`);
    return true;
  }

  /**
   * Validate corpus name to prevent path traversal
   */
  private validateCorpusName(name: string): string {
    const trimmed = name.trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
      throw new Error('Invalid corpus name: only alphanumeric characters, dots, hyphens, and underscores are allowed');
    }
    return trimmed;
  }

  /**
   * Resolve the full file path for a corpus by name
   */
  private getFilePath(name: string): string {
    const safeName = this.validateCorpusName(name);
    const resolved = path.resolve(this.corporaDir, `${safeName}.corpus.json`);
    if (!resolved.startsWith(path.resolve(this.corporaDir) + path.sep)) {
      throw new Error('Invalid corpus name');
    }
    return resolved;
  }
}
