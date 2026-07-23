
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../../../utils/logger.js';
import { paths } from '../../../shared/paths.js';
import { AppError } from '../../server/ErrorHandler.js';
import type { CorpusFile, CorpusStats } from './types.js';

const CORPORA_DIR = paths.corpora();

/**
 * Characters permitted in a corpus name. Anything outside this set (spaces,
 * slashes, non-ASCII) is a client-side input mistake, not a server fault — so
 * validation throws a 400 `AppError`, not a bare 500-mapped `Error`.
 */
export const CORPUS_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const CORPUS_NAME_ERROR =
  'Invalid corpus name: only alphanumeric characters, dots, hyphens, and underscores are allowed';

export class CorpusStore {
  private readonly corporaDir: string;

  constructor() {
    this.corporaDir = CORPORA_DIR;
    if (!fs.existsSync(this.corporaDir)) {
      fs.mkdirSync(this.corporaDir, { recursive: true });
      logger.debug('WORKER', `Created corpora directory: ${this.corporaDir}`);
    }
  }

  write(corpus: CorpusFile): void {
    const filePath = this.getFilePath(corpus.name);
    fs.writeFileSync(filePath, JSON.stringify(corpus, null, 2), 'utf-8');
    logger.debug('WORKER', `Wrote corpus file: ${filePath} (${corpus.observations.length} observations)`);
  }

  read(name: string): CorpusFile | null {
    const filePath = this.getFilePath(name);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as CorpusFile;
    } catch (error) {
      if (error instanceof Error) {
        logger.error('WORKER', `Failed to read corpus file: ${filePath}`, {}, error);
      } else {
        logger.error('WORKER', `Failed to read corpus file: ${filePath} (non-Error thrown)`, { thrownValue: String(error) });
      }
      return null;
    }
  }

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
        if (error instanceof Error) {
          logger.error('WORKER', `Failed to parse corpus file: ${file}`, {}, error);
        } else {
          logger.error('WORKER', `Failed to parse corpus file: ${file} (non-Error thrown)`, { thrownValue: String(error) });
        }
      }
    }

    return results;
  }

  delete(name: string): boolean {
    const filePath = this.getFilePath(name);
    if (!fs.existsSync(filePath)) {
      return false;
    }

    fs.unlinkSync(filePath);
    logger.debug('WORKER', `Deleted corpus file: ${filePath}`);
    return true;
  }

  private validateCorpusName(name: string): string {
    const trimmed = name.trim();
    if (!CORPUS_NAME_PATTERN.test(trimmed)) {
      throw new AppError(CORPUS_NAME_ERROR, 400, 'INVALID_CORPUS_NAME');
    }
    return trimmed;
  }

  private getFilePath(name: string): string {
    const safeName = this.validateCorpusName(name);
    const resolved = path.resolve(this.corporaDir, `${safeName}.corpus.json`);
    if (!resolved.startsWith(path.resolve(this.corporaDir) + path.sep)) {
      throw new AppError('Invalid corpus name', 400, 'INVALID_CORPUS_NAME');
    }
    return resolved;
  }
}
