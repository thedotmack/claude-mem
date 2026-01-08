/**
 * Log Level Audit Test
 *
 * This test scans all TypeScript files in src/ to find logger calls,
 * extracts the message text, and groups them by log level for review.
 *
 * Purpose: Help identify misclassified log messages that should be at a different level.
 *
 * Log Level Guidelines:
 * - ERROR/failure: Critical failures that require investigation (data loss, service down)
 * - WARN: Non-critical issues with fallback behavior (degraded, but functional)
 * - INFO: Normal operational events (session started, request processed)
 * - DEBUG: Detailed diagnostic information (variable values, flow tracing)
 */

import { describe, it, expect } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join, relative } from 'path';

const PROJECT_ROOT = join(import.meta.dir, '..');
const SRC_DIR = join(PROJECT_ROOT, 'src');

interface LoggerCall {
  file: string;
  line: number;
  level: string;
  component: string;
  message: string;
  errorParam: string | null;
  fullMatch: string;
}

/**
 * Recursively find all TypeScript files in a directory
 */
async function findTypeScriptFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await findTypeScriptFiles(fullPath)));
    } else if (entry.isFile() && /\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Extract logger calls from file content
 * Handles multiline calls and captures error parameter (4th arg)
 */
function extractLoggerCalls(content: string, filePath: string): LoggerCall[] {
  const calls: LoggerCall[] = [];
  const lines = content.split('\n');
  const seenCalls = new Set<string>();

  // Build line number index for position-to-line lookup
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }

  function getLineNumber(pos: number): number {
    for (let i = lineStarts.length - 1; i >= 0; i--) {
      if (lineStarts[i] <= pos) return i + 1;
    }
    return 1;
  }

  // Pattern that matches logger calls across multiple lines
  // Captures: method, component, message, and everything up to closing paren
  // Uses [\s\S] instead of . to match newlines
  const loggerPattern = /logger\.(error|warn|info|debug|failure|success|timing|dataIn|dataOut|happyPathError)\s*\(\s*['"]([^'"]+)['"][\s\S]*?\)/g;

  let match: RegExpExecArray | null;
  while ((match = loggerPattern.exec(content)) !== null) {
    const fullMatch = match[0];
    const method = match[1];
    const component = match[2];
    const lineNum = getLineNumber(match.index);

    // Extract message (2nd string arg) - could be single, double, or template
    const messageMatch = fullMatch.match(/['"][^'"]+['"]\s*,\s*(['"`])([\s\S]*?)\1/);
    const message = messageMatch ? messageMatch[2] : '(message not captured)';

    // Extract error parameter (4th arg) - look for "error as Error" or similar patterns
    let errorParam: string | null = null;
    const errorMatch = fullMatch.match(/,\s*(error|err|e)\s+as\s+Error\s*\)/i) ||
                       fullMatch.match(/,\s*(error|err|e)\s*\)/i) ||
                       fullMatch.match(/,\s*new\s+Error\s*\([^)]*\)\s*\)/i);
    if (errorMatch) {
      errorParam = errorMatch[0].replace(/^\s*,\s*/, '').replace(/\s*\)\s*$/, '');
    }

    const key = `${filePath}:${lineNum}:${method}:${message.substring(0, 50)}`;
    if (!seenCalls.has(key)) {
      seenCalls.add(key);
      calls.push({
        file: relative(PROJECT_ROOT, filePath),
        line: lineNum,
        level: normalizeLevel(method),
        component,
        message,
        errorParam,
        fullMatch: fullMatch.replace(/\s+/g, ' ').trim()  // Normalize whitespace for display
      });
    }
  }

  return calls;
}

/**
 * Normalize log level names to standard categories
 */
function normalizeLevel(method: string): string {
  switch (method) {
    case 'error':
    case 'failure':
      return 'ERROR';
    case 'warn':
    case 'happyPathError':
      return 'WARN';
    case 'info':
    case 'success':
    case 'timing':
    case 'dataIn':
    case 'dataOut':
      return 'INFO';
    case 'debug':
      return 'DEBUG';
    default:
      return method.toUpperCase();
  }
}

/**
 * Generate formatted audit report
 */
function generateReport(calls: LoggerCall[]): string {
  const byLevel: Record<string, LoggerCall[]> = {
    'ERROR': [],
    'WARN': [],
    'INFO': [],
    'DEBUG': []
  };

  for (const call of calls) {
    if (byLevel[call.level]) {
      byLevel[call.level].push(call);
    }
  }

  const lines: string[] = [];
  lines.push('\n=== LOG LEVEL AUDIT REPORT ===\n');
  lines.push(`Total logger calls found: ${calls.length}\n`);

  // ERROR level
  lines.push('');
  lines.push('ERROR (should be critical failures only):');
  lines.push('─'.repeat(60));
  if (byLevel['ERROR'].length === 0) {
    lines.push('  (none found)');
  } else {
    for (const call of byLevel['ERROR'].sort((a, b) => a.file.localeCompare(b.file))) {
      lines.push(`  ${call.file}:${call.line} [${call.component}]`);
      lines.push(`    message: "${formatMessage(call.message)}"`);
      if (call.errorParam) {
        lines.push(`    error: ${call.errorParam}`);
      }
      lines.push(`    full: ${call.fullMatch}`);
      lines.push('');
    }
  }
  lines.push(`  Count: ${byLevel['ERROR'].length}`);

  // WARN level
  lines.push('');
  lines.push('WARN (should be non-critical, has fallback):');
  lines.push('─'.repeat(60));
  if (byLevel['WARN'].length === 0) {
    lines.push('  (none found)');
  } else {
    for (const call of byLevel['WARN'].sort((a, b) => a.file.localeCompare(b.file))) {
      lines.push(`  ${call.file}:${call.line} [${call.component}]`);
      lines.push(`    message: "${formatMessage(call.message)}"`);
      if (call.errorParam) {
        lines.push(`    error: ${call.errorParam}`);
      }
      lines.push(`    full: ${call.fullMatch}`);
      lines.push('');
    }
  }
  lines.push(`  Count: ${byLevel['WARN'].length}`);

  // INFO level
  lines.push('');
  lines.push('INFO (informational):');
  lines.push('─'.repeat(60));
  if (byLevel['INFO'].length === 0) {
    lines.push('  (none found)');
  } else {
    for (const call of byLevel['INFO'].sort((a, b) => a.file.localeCompare(b.file))) {
      lines.push(`  ${call.file}:${call.line} [${call.component}]`);
      lines.push(`    message: "${formatMessage(call.message)}"`);
      if (call.errorParam) {
        lines.push(`    error: ${call.errorParam}`);
      }
      lines.push(`    full: ${call.fullMatch}`);
      lines.push('');
    }
  }
  lines.push(`  Count: ${byLevel['INFO'].length}`);

  // DEBUG level
  lines.push('');
  lines.push('DEBUG (detailed diagnostics):');
  lines.push('─'.repeat(60));
  if (byLevel['DEBUG'].length === 0) {
    lines.push('  (none found)');
  } else {
    for (const call of byLevel['DEBUG'].sort((a, b) => a.file.localeCompare(b.file))) {
      lines.push(`  ${call.file}:${call.line} [${call.component}]`);
      lines.push(`    message: "${formatMessage(call.message)}"`);
      if (call.errorParam) {
        lines.push(`    error: ${call.errorParam}`);
      }
      lines.push(`    full: ${call.fullMatch}`);
      lines.push('');
    }
  }
  lines.push(`  Count: ${byLevel['DEBUG'].length}`);

  // Summary
  lines.push('');
  lines.push('=== SUMMARY ===');
  lines.push(`  ERROR: ${byLevel['ERROR'].length}`);
  lines.push(`  WARN:  ${byLevel['WARN'].length}`);
  lines.push(`  INFO:  ${byLevel['INFO'].length}`);
  lines.push(`  DEBUG: ${byLevel['DEBUG'].length}`);
  lines.push(`  TOTAL: ${calls.length}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Format message for display - NO TRUNCATION
 */
function formatMessage(message: string): string {
  return message;
}

describe('Log Level Audit', () => {
  let allCalls: LoggerCall[] = [];

  it('should scan all TypeScript files and extract logger calls', async () => {
    const files = await findTypeScriptFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = await readFile(file, 'utf-8');
      const calls = extractLoggerCalls(content, file);
      allCalls.push(...calls);
    }

    expect(allCalls.length).toBeGreaterThan(0);
  });

  it('should generate audit report for log level review', () => {
    const report = generateReport(allCalls);
    console.log(report);

    // This test always passes - it's for generating a review report
    expect(true).toBe(true);
  });

  it('should have summary statistics', () => {
    const byLevel: Record<string, number> = {
      'ERROR': 0,
      'WARN': 0,
      'INFO': 0,
      'DEBUG': 0
    };

    for (const call of allCalls) {
      if (byLevel[call.level] !== undefined) {
        byLevel[call.level]++;
      }
    }

    console.log('\n📊 Log Level Distribution:');
    console.log(`  ERROR: ${byLevel['ERROR']} (${((byLevel['ERROR'] / allCalls.length) * 100).toFixed(1)}%)`);
    console.log(`  WARN:  ${byLevel['WARN']} (${((byLevel['WARN'] / allCalls.length) * 100).toFixed(1)}%)`);
    console.log(`  INFO:  ${byLevel['INFO']} (${((byLevel['INFO'] / allCalls.length) * 100).toFixed(1)}%)`);
    console.log(`  DEBUG: ${byLevel['DEBUG']} (${((byLevel['DEBUG'] / allCalls.length) * 100).toFixed(1)}%)`);

    // Log distribution health check - not a hard failure, just informational
    // A healthy codebase typically has: DEBUG > INFO > WARN > ERROR
    expect(allCalls.length).toBeGreaterThan(0);
  });
});
