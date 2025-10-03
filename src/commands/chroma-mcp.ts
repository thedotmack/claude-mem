import { OptionValues } from 'commander';
import ChromaMCPClient from '../../chroma-mcp-tools/chroma-mcp-client.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Generic Chroma MCP tool executor
 * Dynamically calls any Chroma MCP tool with provided arguments
 */
export async function executeChromaMCPTool(toolName: string, options: OptionValues): Promise<void> {
  const client = new ChromaMCPClient();

  try {
    await client.connect();

    // Convert commander options to tool arguments
    const toolArgs = convertOptionsToArgs(toolName, options);

    // Call the MCP tool
    const result = await client.callTool(toolName, toolArgs);

    // Parse and format the result nicely
    const formatted = formatMCPResult(result);
    console.log(formatted);

    await client.disconnect();
    process.exit(0);
  } catch (error: any) {
    console.error(JSON.stringify({
      success: false,
      error: error.message || 'Unknown error calling MCP tool',
      tool: toolName
    }, null, 2));

    await client.disconnect();
    process.exit(1);
  }
}

/**
 * Format MCP tool result for clean CLI output
 */
function formatMCPResult(result: any): string {
  // If result has content array (MCP protocol format)
  if (result?.content && Array.isArray(result.content)) {
    const textContent = result.content
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text)
      .join('\n');

    // Try to parse as JSON for prettier output
    try {
      const parsed = JSON.parse(textContent);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // Not JSON, return as-is
      return textContent;
    }
  }

  // If result is already an object, pretty print it
  if (typeof result === 'object') {
    return JSON.stringify(result, null, 2);
  }

  // Fallback to string
  return String(result);
}

/**
 * Convert CLI options to MCP tool arguments
 * Handles type conversion and array parsing
 */
function convertOptionsToArgs(toolName: string, options: OptionValues): Record<string, any> {
  const args: Record<string, any> = {};

  for (const [key, value] of Object.entries(options)) {
    // Skip commander internal properties
    if (key.startsWith('_') || typeof value === 'function') {
      continue;
    }

    // Try to parse JSON strings
    if (typeof value === 'string') {
      try {
        args[key] = JSON.parse(value);
      } catch {
        args[key] = value;
      }
    } else {
      args[key] = value;
    }
  }

  return args;
}

/**
 * Load Chroma MCP tool definitions from JSON
 */
export function loadChromaMCPTools(): Array<{
  name: string;
  description: string;
  inputSchema: any;
}> {
  // Try multiple path resolutions for dev vs production
  const possiblePaths = [
    path.join(__dirname, '../../chroma-mcp-tools/CHROMA_MCP_TOOLS.json'),
    path.join(process.cwd(), 'chroma-mcp-tools/CHROMA_MCP_TOOLS.json'),
    path.join(__dirname, '../chroma-mcp-tools/CHROMA_MCP_TOOLS.json')
  ];

  for (const toolsPath of possiblePaths) {
    if (fs.existsSync(toolsPath)) {
      const toolsJson = fs.readFileSync(toolsPath, 'utf-8');
      return JSON.parse(toolsJson);
    }
  }

  throw new Error('Could not find CHROMA_MCP_TOOLS.json');
}

/**
 * Generate CLI command options from MCP tool schema
 */
export function generateCommandOptions(schema: any): Array<{
  flag: string;
  description: string;
  required: boolean;
  type: string;
}> {
  const options: Array<{
    flag: string;
    description: string;
    required: boolean;
    type: string;
  }> = [];

  if (!schema.properties) return options;

  const required = schema.required || [];

  for (const [propName, propSchema] of Object.entries(schema.properties)) {
    const prop = propSchema as any;
    const isRequired = required.includes(propName);

    // Determine type
    let type = 'string';
    if (prop.type === 'integer' || prop.type === 'number') {
      type = 'number';
    } else if (prop.type === 'array') {
      type = 'array';
    } else if (prop.type === 'object') {
      type = 'json';
    } else if (prop.anyOf) {
      // Handle nullable types
      const nonNullType = prop.anyOf.find((t: any) => t.type !== 'null');
      if (nonNullType?.type === 'integer' || nonNullType?.type === 'number') {
        type = 'number';
      } else if (nonNullType?.type === 'array') {
        type = 'array';
      } else if (nonNullType?.type === 'object') {
        type = 'json';
      }
    }

    // Build flag
    const flag = isRequired
      ? `--${propName} <${type}>`
      : `--${propName} [${type}]`;

    // Build description
    let description = prop.title || propName;
    if (prop.default !== undefined) {
      description += ` (default: ${JSON.stringify(prop.default)})`;
    }
    if (type === 'array') {
      description += ' (JSON array)';
    } else if (type === 'json') {
      description += ' (JSON object)';
    }

    options.push({
      flag,
      description,
      required: isRequired,
      type
    });
  }

  return options;
}
