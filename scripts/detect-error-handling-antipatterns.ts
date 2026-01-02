#!/usr/bin/env bun
/**
 * Error Handling Anti-Pattern Detector
 *
 * Detects try-catch anti-patterns that cause silent failures and debugging nightmares.
 * Run this before committing code that touches error handling.
 *
 * Based on hard-learned lessons: defensive try-catch wastes 10+ hours of debugging time.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

interface AntiPattern {
  file: string;
  line: number;
  pattern: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'APPROVED_OVERRIDE';
  description: string;
  code: string;
  overrideReason?: string;
}

const CRITICAL_PATHS = [
  'SDKAgent.ts',
  'GeminiAgent.ts',
  'OpenRouterAgent.ts',
  'SessionStore.ts',
  'worker-service.ts'
];

function findFilesRecursive(dir: string, pattern: RegExp): string[] {
  const files: string[] = [];

  const items = readdirSync(dir);
  for (const item of items) {
    const fullPath = join(dir, item);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (!item.startsWith('.') && item !== 'node_modules' && item !== 'dist' && item !== 'plugin') {
        files.push(...findFilesRecursive(fullPath, pattern));
      }
    } else if (pattern.test(item)) {
      files.push(fullPath);
    }
  }

  return files;
}

function detectAntiPatterns(filePath: string, projectRoot: string): AntiPattern[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const antiPatterns: AntiPattern[] = [];
  const relPath = relative(projectRoot, filePath);
  const isCriticalPath = CRITICAL_PATHS.some(cp => filePath.includes(cp));

  // Track try-catch blocks
  let inTry = false;
  let tryStartLine = 0;
  let tryLines: string[] = [];
  let braceDepth = 0;
  let catchStartLine = 0;
  let catchLines: string[] = [];
  let inCatch = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect standalone promise empty catch: .catch(() => {})
    const emptyPromiseCatch = trimmed.match(/\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/);
    if (emptyPromiseCatch) {
      antiPatterns.push({
        file: relPath,
        line: i + 1,
        pattern: 'PROMISE_EMPTY_CATCH',
        severity: 'CRITICAL',
        description: 'Promise .catch() with empty handler - errors disappear into the void.',
        code: trimmed
      });
    }

    // Detect standalone promise catch without logging: .catch(err => ...)
    const promiseCatchMatch = trimmed.match(/\.catch\s*\(\s*(?:\(\s*)?(\w+)(?:\s*\))?\s*=>/);
    if (promiseCatchMatch && !emptyPromiseCatch) {
      // Look ahead up to 10 lines to see if there's logging in the handler body
      let catchBody = trimmed.substring(promiseCatchMatch.index || 0);
      let braceCount = (catchBody.match(/{/g) || []).length - (catchBody.match(/}/g) || []).length;

      // Collect subsequent lines if the handler spans multiple lines
      let lookAhead = 0;
      while (braceCount > 0 && lookAhead < 10 && i + lookAhead + 1 < lines.length) {
        lookAhead++;
        const nextLine = lines[i + lookAhead];
        catchBody += '\n' + nextLine;
        braceCount += (nextLine.match(/{/g) || []).length - (nextLine.match(/}/g) || []).length;
      }

      const hasLogging = catchBody.match(/logger\.(error|warn|debug|info)/) ||
                        catchBody.match(/console\.(error|warn)/);

      if (!hasLogging && lookAhead > 0) {  // Only flag if it's actually a multi-line handler
        antiPatterns.push({
          file: relPath,
          line: i + 1,
          pattern: 'PROMISE_CATCH_NO_LOGGING',
          severity: 'CRITICAL',
          description: 'Promise .catch() without logging - errors are silently swallowed.',
          code: catchBody.trim().split('\n').slice(0, 5).join('\n')
        });
      }
    }

    // Detect try block start
    if (trimmed.match(/^\s*try\s*{/) || trimmed.match(/}\s*try\s*{/)) {
      inTry = true;
      tryStartLine = i + 1;
      tryLines = [line];
      braceDepth = 1;
      continue;
    }

    // Track try block content
    if (inTry && !inCatch) {
      tryLines.push(line);

      // Count braces to find try block end
      const openBraces = (line.match(/{/g) || []).length;
      const closeBraces = (line.match(/}/g) || []).length;
      braceDepth += openBraces - closeBraces;

      // Found catch
      if (trimmed.match(/}\s*catch\s*(\(|{)/)) {
        inCatch = true;
        catchStartLine = i + 1;
        catchLines = [line];
        braceDepth = 1;
        continue;
      }
    }

    // Track catch block
    if (inCatch) {
      catchLines.push(line);

      const openBraces = (line.match(/{/g) || []).length;
      const closeBraces = (line.match(/}/g) || []).length;
      braceDepth += openBraces - closeBraces;

      // Catch block ended
      if (braceDepth === 0) {
        // Analyze the try-catch block
        analyzeTryCatchBlock(
          filePath,
          relPath,
          tryStartLine,
          tryLines,
          catchStartLine,
          catchLines,
          isCriticalPath,
          antiPatterns
        );

        // Reset
        inTry = false;
        inCatch = false;
        tryLines = [];
        catchLines = [];
      }
    }
  }

  return antiPatterns;
}

function analyzeTryCatchBlock(
  filePath: string,
  relPath: string,
  tryStartLine: number,
  tryLines: string[],
  catchStartLine: number,
  catchLines: string[],
  isCriticalPath: boolean,
  antiPatterns: AntiPattern[]
): void {
  const tryBlock = tryLines.join('\n');
  const catchBlock = catchLines.join('\n');

  // CRITICAL: Empty catch block
  const catchContent = catchBlock
    .replace(/}\s*catch\s*\([^)]*\)\s*{/, '') // Remove catch signature
    .replace(/}\s*catch\s*{/, '') // Remove catch without param
    .replace(/}$/, '') // Remove closing brace
    .trim();

  // Check for comment-only catch blocks
  const nonCommentContent = catchContent
    .split('\n')
    .filter(line => {
      const t = line.trim();
      return t && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*');
    })
    .join('\n')
    .trim();

  if (!nonCommentContent || nonCommentContent === '') {
    antiPatterns.push({
      file: relPath,
      line: catchStartLine,
      pattern: 'EMPTY_CATCH',
      severity: 'CRITICAL',
      description: 'Empty catch block - errors are silently swallowed. User will waste hours debugging.',
      code: catchBlock.trim()
    });
  }

  // Check for [APPROVED OVERRIDE] marker
  const overrideMatch = catchContent.match(/\/\/\s*\[APPROVED OVERRIDE\]:\s*(.+)/i);
  const overrideReason = overrideMatch?.[1]?.trim();

  // CRITICAL: No logging in catch block (unless explicitly approved)
  const hasLogging = catchContent.match(/logger\.(error|warn|debug|info)/);
  const hasConsoleError = catchContent.match(/console\.(error|warn)/);
  const hasStderr = catchContent.match(/process\.stderr\.write/);
  const hasThrow = catchContent.match(/throw/);

  if (!hasLogging && !hasConsoleError && !hasStderr && !hasThrow && nonCommentContent) {
    if (overrideReason) {
      antiPatterns.push({
        file: relPath,
        line: catchStartLine,
        pattern: 'NO_LOGGING_IN_CATCH',
        severity: 'APPROVED_OVERRIDE',
        description: 'Catch block has no logging - approved override.',
        code: catchBlock.trim(),
        overrideReason
      });
    } else {
      antiPatterns.push({
        file: relPath,
        line: catchStartLine,
        pattern: 'NO_LOGGING_IN_CATCH',
        severity: 'CRITICAL',
        description: 'Catch block has no logging - errors occur invisibly.',
        code: catchBlock.trim()
      });
    }
  }

  // HIGH: Large try block (>10 lines)
  const significantTryLines = tryLines.filter(line => {
    const t = line.trim();
    return t && !t.startsWith('//') && t !== '{' && t !== '}';
  }).length;

  if (significantTryLines > 10) {
    antiPatterns.push({
      file: relPath,
      line: tryStartLine,
      pattern: 'LARGE_TRY_BLOCK',
      severity: 'HIGH',
      description: `Try block has ${significantTryLines} lines - too broad. Multiple errors lumped together.`,
      code: `${tryLines.slice(0, 3).join('\n')}\n... (${significantTryLines} lines) ...`
    });
  }

  // HIGH: Generic catch without type checking
  const catchParam = catchBlock.match(/catch\s*\(([^)]+)\)/)?.[1]?.trim();
  const hasTypeCheck = catchContent.match(/instanceof\s+Error/) ||
                       catchContent.match(/\.name\s*===/) ||
                       catchContent.match(/typeof.*===\s*['"]object['"]/);

  if (catchParam && !hasTypeCheck && nonCommentContent) {
    antiPatterns.push({
      file: relPath,
      line: catchStartLine,
      pattern: 'GENERIC_CATCH',
      severity: 'MEDIUM',
      description: 'Catch block handles all errors identically - no error type discrimination.',
      code: catchBlock.trim()
    });
  }

  // CRITICAL on critical paths: Catch-and-continue
  if (isCriticalPath && nonCommentContent && !hasThrow) {
    const hasReturn = catchContent.match(/return/);
    const continuesExecution = !hasReturn; // If no return/throw, execution continues

    if (continuesExecution && hasLogging) {
      if (overrideReason) {
        antiPatterns.push({
          file: relPath,
          line: catchStartLine,
          pattern: 'CATCH_AND_CONTINUE_CRITICAL_PATH',
          severity: 'APPROVED_OVERRIDE',
          description: 'Critical path continues after error - approved override.',
          code: catchBlock.trim(),
          overrideReason
        });
      } else {
        antiPatterns.push({
          file: relPath,
          line: catchStartLine,
          pattern: 'CATCH_AND_CONTINUE_CRITICAL_PATH',
          severity: 'CRITICAL',
          description: 'Critical path continues after error - may cause silent data corruption.',
          code: catchBlock.trim()
        });
      }
    }
  }

}

function formatReport(antiPatterns: AntiPattern[]): string {
  const critical = antiPatterns.filter(a => a.severity === 'CRITICAL');
  const high = antiPatterns.filter(a => a.severity === 'HIGH');
  const medium = antiPatterns.filter(a => a.severity === 'MEDIUM');
  const approved = antiPatterns.filter(a => a.severity === 'APPROVED_OVERRIDE');

  if (antiPatterns.length === 0) {
    return '✅ No error handling anti-patterns detected!\n';
  }

  let report = '\n';
  report += '═══════════════════════════════════════════════════════════════\n';
  report += '  ERROR HANDLING ANTI-PATTERNS DETECTED\n';
  report += '═══════════════════════════════════════════════════════════════\n\n';
  report += `Found ${critical.length + high.length + medium.length} anti-patterns:\n`;
  report += `  🔴 CRITICAL: ${critical.length}\n`;
  report += `  🟠 HIGH: ${high.length}\n`;
  report += `  🟡 MEDIUM: ${medium.length}\n`;
  if (approved.length > 0) {
    report += `  ⚪ APPROVED OVERRIDES: ${approved.length}\n`;
  }
  report += '\n';

  if (critical.length > 0) {
    report += '🔴 CRITICAL ISSUES (Fix immediately - these cause silent failures):\n';
    report += '─────────────────────────────────────────────────────────────\n\n';
    for (const ap of critical) {
      report += `📁 ${ap.file}:${ap.line}\n`;
      report += `❌ ${ap.pattern}\n`;
      report += `   ${ap.description}\n\n`;
      report += `   Code:\n`;
      const codeLines = ap.code.split('\n');
      for (const line of codeLines.slice(0, 5)) {
        report += `   ${line}\n`;
      }
      if (codeLines.length > 5) {
        report += `   ... (${codeLines.length - 5} more lines)\n`;
      }
      report += '\n';
    }
  }

  if (high.length > 0) {
    report += '🟠 HIGH PRIORITY:\n';
    report += '─────────────────────────────────────────────────────────────\n\n';
    for (const ap of high) {
      report += `📁 ${ap.file}:${ap.line} - ${ap.pattern}\n`;
      report += `   ${ap.description}\n\n`;
    }
  }

  if (medium.length > 0) {
    report += '🟡 MEDIUM PRIORITY:\n';
    report += '─────────────────────────────────────────────────────────────\n\n';
    for (const ap of medium) {
      report += `📁 ${ap.file}:${ap.line} - ${ap.pattern}\n`;
      report += `   ${ap.description}\n\n`;
    }
  }

  if (approved.length > 0) {
    report += '⚪ APPROVED OVERRIDES (Review reasons for accuracy):\n';
    report += '─────────────────────────────────────────────────────────────\n\n';
    for (const ap of approved) {
      report += `📁 ${ap.file}:${ap.line} - ${ap.pattern}\n`;
      report += `   Reason: ${ap.overrideReason}\n`;
      report += `   Code:\n`;
      const codeLines = ap.code.split('\n');
      for (const line of codeLines.slice(0, 3)) {
        report += `   ${line}\n`;
      }
      if (codeLines.length > 3) {
        report += `   ... (${codeLines.length - 3} more lines)\n`;
      }
      report += '\n';
    }
  }

  report += '═══════════════════════════════════════════════════════════════\n';
  report += 'REMINDER: Every try-catch must answer these questions:\n';
  report += '1. What SPECIFIC error am I catching? (Name it)\n';
  report += '2. Show me documentation proving this error can occur\n';
  report += '3. Why can\'t this error be prevented?\n';
  report += '4. What will the catch block DO? (Log + rethrow? Fallback?)\n';
  report += '5. Why shouldn\'t this error propagate to the caller?\n';
  report += '\n';
  report += 'To approve an anti-pattern, add: // [APPROVED OVERRIDE]: reason\n';
  report += '═══════════════════════════════════════════════════════════════\n\n';

  return report;
}

// Main execution
const projectRoot = process.cwd();
const srcDir = join(projectRoot, 'src');

console.log('🔍 Scanning for error handling anti-patterns...\n');

const tsFiles = findFilesRecursive(srcDir, /\.ts$/);
console.log(`Found ${tsFiles.length} TypeScript files\n`);

let allAntiPatterns: AntiPattern[] = [];

for (const file of tsFiles) {
  const patterns = detectAntiPatterns(file, projectRoot);
  allAntiPatterns = allAntiPatterns.concat(patterns);
}

const report = formatReport(allAntiPatterns);
console.log(report);

// Exit with error code if critical issues found
const critical = allAntiPatterns.filter(a => a.severity === 'CRITICAL');
if (critical.length > 0) {
  console.error(`❌ FAILED: ${critical.length} critical error handling anti-patterns must be fixed.\n`);
  process.exit(1);
}

process.exit(0);
