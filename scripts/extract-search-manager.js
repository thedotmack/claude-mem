#!/usr/bin/env node

/**
 * One-time script to extract tool handlers from mcp-server.ts into SearchManager.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const mcpServerPath = join(projectRoot, 'src/servers/mcp-server.ts');
const outputPath = join(projectRoot, 'src/services/worker/SearchManager.ts');

console.log('Reading mcp-server.ts...');
const content = readFileSync(mcpServerPath, 'utf-8');

// Extract just the sections we need by finding line numbers
// This is more reliable than parsing

// Extract tool handler bodies by finding each "handler: async (args: any) => {"
// and extracting until the matching closing brace

const extractHandlerBody = (content, startPattern) => {
  const lines = content.split('\n');
  const startIdx = lines.findIndex(line => line.includes(startPattern));

  if (startIdx === -1) return null;

  // Find the "handler: async (args: any) => {" line
  let handlerIdx = -1;
  for (let i = startIdx; i < Math.min(startIdx + 30, lines.length); i++) {
    if (lines[i].includes('handler: async (args: any) => {')) {
      handlerIdx = i;
      break;
    }
  }

  if (handlerIdx === -1) return null;

  // Extract the body by counting braces
  let braceCount = 0;
  let bodyLines = [];
  let started = false;

  for (let i = handlerIdx; i < lines.length; i++) {
    const line = lines[i];

    for (const char of line) {
      if (char === '{') {
        braceCount++;
        started = true;
      } else if (char === '}') {
        braceCount--;
      }
    }

    if (started) {
      bodyLines.push(line);
    }

    if (started && braceCount === 0) {
      break;
    }
  }

  // Remove the first line (handler wrapper) and last line (closing brace)
  if (bodyLines.length > 2) {
    bodyLines = bodyLines.slice(1, -1);
  }

  return bodyLines.join('\n');
};

// Tool name to search pattern mapping
const tools = {
  'search': "name: 'search'",
  'timeline': "name: 'timeline'",
  'decisions': "name: 'decisions'",
  'changes': "name: 'changes'",
  'how_it_works': "name: 'how_it_works'",
  'search_observations': "name: 'search_observations'",
  'search_sessions': "name: 'search_sessions'",
  'search_user_prompts': "name: 'search_user_prompts'",
  'find_by_concept': "name: 'find_by_concept'",
  'find_by_file': "name: 'find_by_file'",
  'find_by_type': "name: 'find_by_type'",
  'get_recent_context': "name: 'get_recent_context'",
  'get_context_timeline': "name: 'get_context_timeline'",
  'get_timeline_by_query': "name: 'get_timeline_by_query'"
};

console.log('Extracting tool handlers...');
const handlers = {};

for (const [toolName, pattern] of Object.entries(tools)) {
  console.log(`  Extracting ${toolName}...`);
  const body = extractHandlerBody(content, pattern);
  if (body) {
    handlers[toolName] = body;
    console.log(`    ✓ ${body.split('\n').length} lines`);
  } else {
    console.log(`    ✗ Not found`);
  }
}

console.log(`\nExtracted ${Object.keys(handlers).length}/${Object.keys(tools).length} handlers`);

// Now generate SearchManager.ts
console.log('\nGenerating SearchManager.ts...');

const methodBodies = Object.entries(handlers).map(([toolName, body]) => {
  // Convert tool name to camelCase method name
  const methodName = toolName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

  // Replace standalone function calls with class methods
  let processedBody = body
    .replace(/formatSearchTips\(\)/g, 'this.formatter.formatSearchTips()')
    .replace(/formatObservationIndex\(/g, 'this.formatter.formatObservationIndex(')
    .replace(/formatSessionIndex\(/g, 'this.formatter.formatSessionIndex(')
    .replace(/formatUserPromptIndex\(/g, 'this.formatter.formatUserPromptIndex(')
    .replace(/formatObservationResult\(/g, 'this.formatter.formatObservationResult(')
    .replace(/formatSessionResult\(/g, 'this.formatter.formatSessionResult(')
    .replace(/formatUserPromptResult\(/g, 'this.formatter.formatUserPromptResult(')
    .replace(/filterTimelineByDepth\(/g, 'this.timeline.filterByDepth(')
    .replace(/\bsearch\./g, 'this.sessionSearch.')
    .replace(/\bstore\./g, 'this.sessionStore.')
    .replace(/queryChroma\(/g, 'this.queryChroma(')
    .replace(/normalizeParams\(/g, 'this.normalizeParams(')
    .replace(/chromaClient/g, 'this.chromaSync');

  return `  /**
   * Tool handler: ${toolName}
   */
  async ${methodName}(args: any): Promise<any> {
${processedBody}
  }`;
}).join('\n\n');

const searchManagerContent = `/**
 * SearchManager - Core search orchestration for claude-mem
 * Extracted from mcp-server.ts to centralize business logic in Worker services
 *
 * This class contains all tool handler logic that was previously in the MCP server.
 * The MCP server now acts as a thin HTTP wrapper that calls these methods via HTTP.
 */

import { SessionSearch } from '../sqlite/SessionSearch.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { FormattingService } from './FormattingService.js';
import { TimelineService, TimelineItem } from './TimelineService.js';
import { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../sqlite/types.js';
import { silentDebug } from '../../utils/silent-debug.js';

const COLLECTION_NAME = 'cm__claude-mem';

export class SearchManager {
  constructor(
    private sessionSearch: SessionSearch,
    private sessionStore: SessionStore,
    private chromaSync: ChromaSync,
    private formatter: FormattingService,
    private timeline: TimelineService
  ) {}

  /**
   * Query Chroma vector database via ChromaSync
   */
  private async queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }> {
    return await this.chromaSync.queryChroma(query, limit, whereFilter);
  }

  /**
   * Helper to normalize query parameters from URL-friendly format
   * Converts comma-separated strings to arrays and flattens date params
   */
  private normalizeParams(args: any): any {
    const normalized: any = { ...args };

    // Parse comma-separated concepts into array
    if (normalized.concepts && typeof normalized.concepts === 'string') {
      normalized.concepts = normalized.concepts.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Parse comma-separated files into array
    if (normalized.files && typeof normalized.files === 'string') {
      normalized.files = normalized.files.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Parse comma-separated obs_type into array
    if (normalized.obs_type && typeof normalized.obs_type === 'string') {
      normalized.obs_type = normalized.obs_type.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Parse comma-separated type (for filterSchema) into array
    if (normalized.type && typeof normalized.type === 'string' && normalized.type.includes(',')) {
      normalized.type = normalized.type.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Flatten dateStart/dateEnd into dateRange object
    if (normalized.dateStart || normalized.dateEnd) {
      normalized.dateRange = {
        start: normalized.dateStart,
        end: normalized.dateEnd
      };
      delete normalized.dateStart;
      delete normalized.dateEnd;
    }

    return normalized;
  }

${methodBodies}
}
`;

writeFileSync(outputPath, searchManagerContent, 'utf-8');

console.log(`\n✅ SearchManager.ts generated at ${outputPath}`);
console.log(`   Total methods: ${Object.keys(handlers).length + 2} (${Object.keys(handlers).length} tools + queryChroma + normalizeParams)`);
console.log(`   File size: ${(searchManagerContent.length / 1024).toFixed(1)} KB`);
