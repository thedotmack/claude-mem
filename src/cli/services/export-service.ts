/**
 * Export Service - Export data to various formats
 */

import { existsSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { paths } from '../utils/paths';

export interface ExportOptions {
  format: 'json' | 'markdown';
  output: string;
  since?: Date;
  project?: string;
}

export interface Observation {
  id: number;
  sessionId: string;
  project: string;
  type: string;
  text: string;
  title?: string;
  narrative?: string;
  createdAt: string;
}

export class ExportService {
  private dbPath = paths.database;

  /**
   * Export observations
   */
  export(options: ExportOptions): { success: boolean; count: number; error?: string } {
    try {
      const observations = this.getObservations(options);
      
      if (options.format === 'json') {
        writeFileSync(options.output, JSON.stringify(observations, null, 2));
      } else if (options.format === 'markdown') {
        const markdown = this.toMarkdown(observations);
        writeFileSync(options.output, markdown);
      }

      return { success: true, count: observations.length };
    } catch (error) {
      return { success: false, count: 0, error: (error as Error).message };
    }
  }

  /**
   * Get observations from database
   */
  private getObservations(options: ExportOptions): Observation[] {
    let sql = `
      SELECT 
        o.id,
        o.memory_session_id as sessionId,
        o.project,
        o.type,
        o.text,
        o.title,
        o.narrative,
        o.created_at as createdAt
      FROM observations o
      WHERE 1=1
    `;

    if (options.since) {
      sql += ` AND o.created_at_epoch > ${options.since.getTime()}`;
    }

    if (options.project) {
      sql += ` AND o.project = '${options.project}'`;
    }

    sql += ` ORDER BY o.created_at_epoch DESC`;

    const result = this.query(sql);
    return result ? this.parseObservations(result) : [];
  }

  /**
   * Convert to Markdown
   */
  private toMarkdown(observations: Observation[]): string {
    const lines: string[] = [
      '# Claude-Mem Export',
      '',
      `Generated: ${new Date().toISOString()}`,
      `Total: ${observations.length} observations`,
      '',
      '---',
      ''
    ];

    for (const obs of observations) {
      lines.push(`## ${obs.title || obs.type} (#${obs.id})`);
      lines.push('');
      lines.push(`- **Project:** ${obs.project}`);
      lines.push(`- **Type:** ${obs.type}`);
      lines.push(`- **Date:** ${obs.createdAt}`);
      lines.push(`- **Session:** ${obs.sessionId}`);
      lines.push('');
      lines.push(obs.narrative || obs.text || '');
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }

  private parseObservations(result: string): Observation[] {
    return result.split('\n')
      .filter(line => line.trim())
      .map(line => {
        const parts = line.split('|');
        return {
          id: parseInt(parts[0]?.trim() || '0', 10),
          sessionId: parts[1]?.trim() || '',
          project: parts[2]?.trim() || '',
          type: parts[3]?.trim() || '',
          text: parts[4]?.trim() || '',
          title: parts[5]?.trim() || '',
          narrative: parts[6]?.trim() || '',
          createdAt: parts[7]?.trim() || ''
        };
      });
  }

  private query(sql: string): string | null {
    try {
      const result = spawnSync('sqlite3', [this.dbPath, sql], {
        encoding: 'utf-8',
        timeout: 30000
      });
      return result.status === 0 ? result.stdout : null;
    } catch {
      return null;
    }
  }
}

export const exportService = new ExportService();
