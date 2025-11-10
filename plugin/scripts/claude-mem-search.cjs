#!/usr/bin/env node

/**
 * claude-mem-search: Unified search wrapper for claude-mem HTTP API
 * 
 * This script wraps all search API endpoints with proper error handling
 * and output formatting, reducing permission prompts in Claude Code.
 * 
 * Usage:
 *   claude-mem-search observations "query" [--format=index] [--limit=20] [--project=name] [--from=date] [--to=date]
 *   claude-mem-search sessions "query" [options]
 *   claude-mem-search prompts "query" [options]
 *   claude-mem-search by-type <type> [options]
 *   claude-mem-search by-concept <concept> [options]
 *   claude-mem-search by-file <path> [options]
 *   claude-mem-search recent [--project=name] [--limit=3]
 *   claude-mem-search timeline <anchor> [--depth-before=10] [--depth-after=10] [--project=name]
 *   claude-mem-search timeline-by-query "query" [options]
 *   claude-mem-search help
 */

const http = require('http');
const { URL } = require('url');

// Get worker port from environment or use default
const WORKER_PORT = parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777', 10);
const BASE_URL = `http://localhost:${WORKER_PORT}`;

/**
 * Make HTTP GET request to the worker service
 */
function makeRequest(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, BASE_URL);
    
    // Add query parameters
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    });

    http.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (error) {
            reject(new Error(`Failed to parse JSON response: ${error.message}`));
          }
        } else {
          try {
            const json = JSON.parse(data);
            reject(new Error(json.error || `HTTP ${res.statusCode}`));
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        }
      });
    }).on('error', (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });
  });
}

/**
 * Parse command-line arguments
 */
function parseArgs(args) {
  const parsed = {
    positional: [],
    flags: {}
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      parsed.flags[key] = value || true;
    } else {
      parsed.positional.push(arg);
    }
  }

  return parsed;
}

/**
 * Format JSON output for display
 */
function formatOutput(data) {
  return JSON.stringify(data, null, 2);
}

/**
 * Main command handler
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: claude-mem-search <command> [arguments] [options]');
    console.error('Run "claude-mem-search help" for more information');
    process.exit(1);
  }

  const { positional, flags } = parseArgs(args);
  const command = positional[0];

  try {
    let result;

    switch (command) {
      case 'observations':
        if (positional.length < 2) {
          throw new Error('Missing query argument');
        }
        result = await makeRequest('/api/search/observations', {
          query: positional[1],
          format: flags.format,
          limit: flags.limit,
          project: flags.project,
          from: flags.from,
          to: flags.to
        });
        break;

      case 'sessions':
        if (positional.length < 2) {
          throw new Error('Missing query argument');
        }
        result = await makeRequest('/api/search/sessions', {
          query: positional[1],
          format: flags.format,
          limit: flags.limit,
          project: flags.project,
          from: flags.from,
          to: flags.to
        });
        break;

      case 'prompts':
        if (positional.length < 2) {
          throw new Error('Missing query argument');
        }
        result = await makeRequest('/api/search/prompts', {
          query: positional[1],
          format: flags.format,
          limit: flags.limit,
          project: flags.project,
          from: flags.from,
          to: flags.to
        });
        break;

      case 'by-type':
        if (positional.length < 2) {
          throw new Error('Missing type argument');
        }
        result = await makeRequest('/api/search/by-type', {
          type: positional[1],
          format: flags.format,
          limit: flags.limit,
          project: flags.project,
          from: flags.from,
          to: flags.to
        });
        break;

      case 'by-concept':
        if (positional.length < 2) {
          throw new Error('Missing concept argument');
        }
        result = await makeRequest('/api/search/by-concept', {
          concept: positional[1],
          format: flags.format,
          limit: flags.limit,
          project: flags.project,
          from: flags.from,
          to: flags.to
        });
        break;

      case 'by-file':
        if (positional.length < 2) {
          throw new Error('Missing file path argument');
        }
        result = await makeRequest('/api/search/by-file', {
          filePath: positional[1],
          format: flags.format,
          limit: flags.limit,
          project: flags.project,
          from: flags.from,
          to: flags.to
        });
        break;

      case 'recent':
        result = await makeRequest('/api/context/recent', {
          project: flags.project,
          limit: flags.limit
        });
        break;

      case 'timeline':
        if (positional.length < 2) {
          throw new Error('Missing anchor argument');
        }
        result = await makeRequest('/api/context/timeline', {
          anchor: positional[1],
          depth_before: flags['depth-before'],
          depth_after: flags['depth-after'],
          project: flags.project
        });
        break;

      case 'timeline-by-query':
        if (positional.length < 2) {
          throw new Error('Missing query argument');
        }
        result = await makeRequest('/api/timeline/by-query', {
          query: positional[1],
          mode: flags.mode,
          depth_before: flags['depth-before'],
          depth_after: flags['depth-after'],
          limit: flags.limit,
          project: flags.project
        });
        break;

      case 'help':
        result = await makeRequest('/api/search/help');
        break;

      default:
        throw new Error(`Unknown command: ${command}. Run "claude-mem-search help" for available commands.`);
    }

    console.log(formatOutput(result));
    process.exit(0);

  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
