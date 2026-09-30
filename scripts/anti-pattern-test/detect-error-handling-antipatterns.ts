#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

interface AntiPattern {
  file: string;
  line: number;
  pattern: string;
  severity: 'ISSUE' | 'APPROVED_OVERRIDE';
  description: string;
  code: string;
  overrideReason?: string;
}

const CRITICAL_PATHS = [
  'ClaudeProvider.ts',
  'GeminiProvider.ts',
  'OpenRouterProvider.ts',
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const hasOverride = trimmed.includes('[ANTI-PATTERN IGNORED]') ||
                       (i > 0 && lines[i - 1].includes('[ANTI-PATTERN IGNORED]'));
    const overrideMatch = (trimmed + (i > 0 ? lines[i - 1] : '')).match(/\[ANTI-PATTERN IGNORED\]:\s*(.+)/i);
    const overrideReason = overrideMatch?.[1]?.trim();

    const errorStringMatchPatterns = [
      /error(?:Message|\.message)\s*\.includes\s*\(\s*['"`](\w+)['"`]\s*\)/i,
      /(?:err|e)\.message\s*\.includes\s*\(\s*['"`](\w+)['"`]\s*\)/i,
      /String\s*\(\s*(?:error|err|e)\s*\)\s*\.includes\s*\(\s*['"`](\w+)['"`]\s*\)/i,
    ];

    for (const pattern of errorStringMatchPatterns) {
      const match = trimmed.match(pattern);
      if (match) {
        const matchedString = match[1];
        const genericPatterns = ['error', 'fail', 'connection', 'timeout', 'not', 'invalid', 'unable'];
        const isGeneric = genericPatterns.some(gp => matchedString.toLowerCase().includes(gp));

        if (hasOverride && overrideReason) {
          antiPatterns.push({
            file: relPath,
            line: i + 1,
            pattern: 'ERROR_STRING_MATCHING',
            severity: 'APPROVED_OVERRIDE',
            description: `Error type detection via string matching on "${matchedString}" - approved override.`,
            code: trimmed,
            overrideReason
          });
        } else {
          antiPatterns.push({
            file: relPath,
            line: i + 1,
            pattern: 'ERROR_STRING_MATCHING',
            severity: 'ISSUE',
            description: `Error type detection via string matching on "${matchedString}" - fragile and masks the real error. Log the FULL error object. We don't care about pretty error handling, we care about SEEING what went wrong.`,
            code: trimmed
          });
        }
      }
    }

    const partialErrorLoggingPatterns = [
      /logger\.(error|warn|info|debug|failure)\s*\([^)]*,\s*(?:error|err|e)\.message\s*\)/,
      /logger\.(error|warn|info|debug|failure)\s*\([^)]*\{\s*(?:error|err|e):\s*(?:error|err|e)\.message\s*\}/,
      /console\.(error|warn|log)\s*\(\s*(?:error|err|e)\.message\s*\)/,
      /console\.(error|warn|log)\s*\(\s*['"`][^'"`]+['"`]\s*,\s*(?:error|err|e)\.message\s*\)/,
    ];

    for (const pattern of partialErrorLoggingPatterns) {
      if (pattern.test(trimmed)) {
        if (hasOverride && overrideReason) {
          antiPatterns.push({
            file: relPath,
            line: i + 1,
            pattern: 'PARTIAL_ERROR_LOGGING',
            severity: 'APPROVED_OVERRIDE',
            description: 'Logging only error.message instead of full error object - approved override.',
            code: trimmed,
            overrideReason
          });
        } else {
          antiPatterns.push({
            file: relPath,
            line: i + 1,
            pattern: 'PARTIAL_ERROR_LOGGING',
            severity: 'ISSUE',
            description: 'Logging only error.message HIDES the stack trace, error type, and all properties. ALWAYS pass the full error object - you need the complete picture, not a summary.',
            code: trimmed
          });
        }
      }
    }

    const multipleIncludes = trimmed.match(/(?:error(?:Message|\.message)|(?:err|e)\.message).*\.includes.*\|\|.*\.includes/i);
    if (multipleIncludes) {
      if (hasOverride && overrideReason) {
        antiPatterns.push({
          file: relPath,
          line: i + 1,
          pattern: 'ERROR_MESSAGE_GUESSING',
          severity: 'APPROVED_OVERRIDE',
          description: 'Multiple string checks on error message to guess error type - approved override.',
          code: trimmed,
          overrideReason
        });
      } else {
        antiPatterns.push({
          file: relPath,
          line: i + 1,
          pattern: 'ERROR_MESSAGE_GUESSING',
          severity: 'ISSUE',
          description: 'Multiple string checks on error message to guess error type. STOP GUESSING. Log the FULL error object. We don\'t care what the library throws - we care about SEEING the error when it happens.',
          code: trimmed
        });
      }
    }
  }

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

    const emptyPromiseCatch = trimmed.match(/\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/);
    if (emptyPromiseCatch) {
      antiPatterns.push({
        file: relPath,
        line: i + 1,
        pattern: 'PROMISE_EMPTY_CATCH',
        severity: 'ISSUE',
        description: 'Promise .catch() with empty handler - errors disappear into the void.',
        code: trimmed
      });
    }

    const promiseCatchMatch = trimmed.match(/\.catch\s*\(\s*(?:\(\s*)?(\w+)(?:\s*\))?\s*=>/);
    if (promiseCatchMatch && !emptyPromiseCatch) {
      let catchBody = trimmed.substring(promiseCatchMatch.index || 0);
      let braceCount = (catchBody.match(/{/g) || []).length - (catchBody.match(/}/g) || []).length;

      let lookAhead = 0;
      while (braceCount > 0 && lookAhead < 10 && i + lookAhead + 1 < lines.length) {
        lookAhead++;
        const nextLine = lines[i + lookAhead];
        catchBody += '\n' + nextLine;
        braceCount += (nextLine.match(/{/g) || []).length - (nextLine.match(/}/g) || []).length;
      }

      const hasLogging = catchBody.match(/logger\.(error|warn|debug|info|failure)/) ||
                        catchBody.match(/console\.(error|warn)/);

      if (!hasLogging && lookAhead > 0) {  // Only flag if it's actually a multi-line handler
        antiPatterns.push({
          file: relPath,
          line: i + 1,
          pattern: 'PROMISE_CATCH_NO_LOGGING',
          severity: 'ISSUE',
          description: 'Promise .catch() without logging - errors are silently swallowed.',
          code: catchBody.trim().split('\n').slice(0, 5).join('\n')
        });
      }
    }

    if (!inCatch && (trimmed.match(/^\s*try\s*{/) || trimmed.match(/}\s*try\s*{/))) {
      inTry = true;
      tryStartLine = i + 1;
      tryLines = [line];
      braceDepth = 1;
      continue;
    }

    if (inTry && !inCatch) {
      tryLines.push(line);

      const openBraces = (line.match(/{/g) || []).length;
      const closeBraces = (line.match(/}/g) || []).length;
      braceDepth += openBraces - closeBraces;

      if (trimmed.match(/}\s*catch\s*(\(|{)/)) {
        inCatch = true;
        catchStartLine = i + 1;
        catchLines = [line];
        braceDepth = 1;
        continue;
      }
    }

    if (inCatch) {
      catchLines.push(line);

      const openBraces = (line.match(/{/g) || []).length;
      const closeBraces = (line.match(/}/g) || []).length;
      braceDepth += openBraces - closeBraces;

      if (braceDepth === 0) {
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

  const catchContent = catchBlock
    .replace(/}\s*catch\s*\([^)]*\)\s*{/, '')
    .replace(/}\s*catch\s*{/, '')
    .replace(/}\s*$/, '')
    .trim();

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

  const overrideMatch = catchContent.match(/\/\/\s*\[ANTI-PATTERN IGNORED\]:\s*(.+)/i);
  const overrideReason = overrideMatch?.[1]?.trim();

  const hasLogging = catchContent.match(/logger\.(error|warn|debug|info|failure)/);
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
        severity: 'ISSUE',
        description: 'Catch block has no logging - errors occur invisibly.',
        code: catchBlock.trim()
      });
    }
  }

  const significantTryLines = tryLines.filter(line => {
    const t = line.trim();
    return t && !t.startsWith('//') && t !== '{' && t !== '}';
  }).length;

  if (significantTryLines > 10) {
    antiPatterns.push({
      file: relPath,
      line: tryStartLine,
      pattern: 'LARGE_TRY_BLOCK',
      severity: 'ISSUE',
      description: `Try block has ${significantTryLines} lines - too broad. Multiple errors lumped together.`,
      code: `${tryLines.slice(0, 3).join('\n')}\n... (${significantTryLines} lines) ...`
    });
  }

  const catchParam = catchBlock.match(/catch\s*\(([^)]+)\)/)?.[1]?.trim();
  const hasTypeCheck = catchContent.match(/instanceof\s+Error/) ||
                       catchContent.match(/\.name\s*===/) ||
                       catchContent.match(/typeof.*===\s*['"]object['"]/);

  if (catchParam && !hasTypeCheck && nonCommentContent) {
    antiPatterns.push({
      file: relPath,
      line: catchStartLine,
      pattern: 'GENERIC_CATCH',
      severity: 'ISSUE',
      description: 'Catch block handles all errors identically - no error type discrimination.',
      code: catchBlock.trim()
    });
  }

  if (isCriticalPath && nonCommentContent && !hasThrow) {
    const hasReturn = catchContent.match(/return/);
    const hasProcessExit = catchContent.match(/process\.exit/);
    const terminatesExecution = hasReturn || hasProcessExit;

    if (!terminatesExecution && hasLogging) {
      if (overrideReason) {
        antiPatterns.push({
          file: relPath,
          line: catchStartLine,
          pattern: 'CATCH_AND_CONTINUE_CRITICAL_PATH',
          severity: 'APPROVED_OVERRIDE',
          description: 'Critical path continues after error - anti-pattern ignored.',
          code: catchBlock.trim(),
          overrideReason
        });
      } else {
        antiPatterns.push({
          file: relPath,
          line: catchStartLine,
          pattern: 'CATCH_AND_CONTINUE_CRITICAL_PATH',
          severity: 'ISSUE',
          description: 'Critical path continues after error - may cause silent data corruption.',
          code: catchBlock.trim()
        });
      }
    }
  }

}

function formatReport(antiPatterns: AntiPattern[]): string {
  const issues = antiPatterns.filter(a => a.severity === 'ISSUE');
  const approved = antiPatterns.filter(a => a.severity === 'APPROVED_OVERRIDE');

  if (antiPatterns.length === 0) {
    return '✅ No error handling anti-patterns detected!\n';
  }

  let report = '\n';
  report += '═══════════════════════════════════════════════════════════════\n';
  report += '  ERROR HANDLING ANTI-PATTERNS DETECTED\n';
  report += '═══════════════════════════════════════════════════════════════\n\n';
  report += `Found ${issues.length} anti-patterns that must be fixed:\n`;
  if (approved.length > 0) {
    report += `  ⚪ APPROVED OVERRIDES: ${approved.length}\n`;
  }
  report += '\n';

  if (issues.length > 0) {
    report += '❌ ISSUES TO FIX:\n';
    report += '─────────────────────────────────────────────────────────────\n\n';
    for (const ap of issues) {
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
  report += 'To ignore an anti-pattern, add: // [ANTI-PATTERN IGNORED]: reason\n';
  report += '═══════════════════════════════════════════════════════════════\n\n';

  return report;
}

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

const issues = allAntiPatterns.filter(a => a.severity === 'ISSUE');
if (issues.length > 0) {
  console.error(`❌ FAILED: ${issues.length} error handling anti-patterns must be fixed.\n`);
  process.exit(1);
}

process.exit(0);
