/**
 * Log Service - Read and manage worker log files
 */

import { existsSync, readdirSync, readFileSync, statSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { paths } from '../utils/paths';

export interface LogEntry {
  timestamp: string;
  level: string;
  component: string;
  message: string;
  raw: string;
}

export interface LogFilter {
  level?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  session?: string;
  since?: Date;
  until?: Date;
}

export class LogService {
  private logsDir = paths.logsDir;

  /**
   * Get list of available log files
   */
  getLogFiles(): { name: string; date: string; size: number }[] {
    if (!existsSync(this.logsDir)) return [];

    return readdirSync(this.logsDir)
      .filter(f => f.startsWith('worker-') && f.endsWith('.log'))
      .map(f => {
        const path = join(this.logsDir, f);
        const stats = statSync(path);
        const dateMatch = f.match(/worker-(\d{4}-\d{2}-\d{2})/);
        return {
          name: f,
          date: dateMatch ? dateMatch[1] : '',
          size: stats.size
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * Get today's log file path
   */
  getTodayLogPath(): string {
    const date = new Date().toISOString().slice(0, 10);
    return join(this.logsDir, `worker-${date}.log`);
  }

  /**
   * Read log file with optional tail
   */
  async readLogs(options: {
    tail?: number;
    file?: string;
    filter?: LogFilter;
  } = {}): Promise<LogEntry[]> {
    const logPath = options.file || this.getTodayLogPath();
    
    if (!existsSync(logPath)) {
      return [];
    }

    const entries: LogEntry[] = [];
    const lines: string[] = [];

    // Read all lines or tail
    if (options.tail) {
      // Read file and keep last N lines
      const content = readFileSync(logPath, 'utf-8');
      const allLines = content.split('\n');
      lines.push(...allLines.slice(-options.tail));
    } else {
      const content = readFileSync(logPath, 'utf-8');
      lines.push(...content.split('\n'));
    }

    // Parse lines
    for (const line of lines) {
      if (!line.trim()) continue;

      const entry = this.parseLogLine(line);
      
      // Apply filters
      if (options.filter) {
        if (options.filter.level && entry.level !== options.filter.level) continue;
        if (options.filter.session && !entry.message.includes(options.filter.session)) continue;
      }

      entries.push(entry);
    }

    return entries;
  }

  /**
   * Stream logs in real-time (follow mode)
   */
  async *followLogs(file?: string): AsyncGenerator<LogEntry> {
    const logPath = file || this.getTodayLogPath();
    
    if (!existsSync(logPath)) {
      return;
    }

    const stream = createReadStream(logPath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (line.trim()) {
        yield this.parseLogLine(line);
      }
    }
  }

  /**
   * Clean old log files
   */
  cleanOldLogs(days: number): { deleted: number; freed: number } {
    const files = this.getLogFiles();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    let deleted = 0;
    let freed = 0;

    for (const file of files) {
      const fileDate = new Date(file.date);
      if (fileDate < cutoff) {
        const fs = require('fs');
        fs.unlinkSync(join(this.logsDir, file.name));
        deleted++;
        freed += file.size;
      }
    }

    return { deleted, freed };
  }

  /**
   * Parse a single log line
   */
  private parseLogLine(line: string): LogEntry {
    // Format: [2026-03-03 14:32:10.123] [INFO] [WORKER] Message
    const match = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\] \[(\w+)\] \[(\w+)\] (.+)$/);
    
    if (match) {
      return {
        timestamp: match[1],
        level: match[2],
        component: match[3],
        message: match[4],
        raw: line
      };
    }

    // Fallback for malformed lines
    return {
      timestamp: '',
      level: 'UNKNOWN',
      component: 'UNKNOWN',
      message: line,
      raw: line
    };
  }

  /**
   * Get total size of all logs
   */
  getTotalSize(): number {
    const files = this.getLogFiles();
    return files.reduce((sum, f) => sum + f.size, 0);
  }
}

export const logService = new LogService();
