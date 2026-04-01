import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PromptFrontmatterSchema, type Prompt } from './types.js';

export class PromptParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly reason: string,
  ) {
    super(`Failed to parse prompt ${filePath}: ${reason}`);
    this.name = 'PromptParseError';
  }
}

export class PromptDirectoryNotFoundError extends Error {
  constructor(public readonly dirPath: string) {
    super(`Prompts directory not found: ${dirPath}`);
    this.name = 'PromptDirectoryNotFoundError';
  }
}

/**
 * Splits a markdown file into YAML frontmatter and body content.
 * Frontmatter is delimited by `---` at the start and end.
 */
function splitFrontmatterAndBody(
  content: string,
): { rawFrontmatter: string; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    throw new Error('File does not start with YAML frontmatter delimiter (---)');
  }

  // Find the closing `---` delimiter (skip the opening one)
  const closingIndex = trimmed.indexOf('---', 3);
  if (closingIndex === -1) {
    throw new Error('No closing YAML frontmatter delimiter (---) found');
  }

  const rawFrontmatter = trimmed.slice(3, closingIndex).trim();
  const body = trimmed.slice(closingIndex + 3).trim();

  return { rawFrontmatter, body };
}

/**
 * Loads all `.md` prompt files from the given directory,
 * parses their YAML frontmatter, validates against PromptFrontmatterSchema,
 * and returns them sorted by id.
 */
export async function loadPrompts(promptsDir: string): Promise<Prompt[]> {
  let entries: string[];
  try {
    entries = await readdir(promptsDir);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      throw new PromptDirectoryNotFoundError(promptsDir);
    }
    throw error;
  }

  const markdownFiles = entries
    .filter((entry) => entry.endsWith('.md'))
    .sort();

  const prompts: Prompt[] = [];

  for (const fileName of markdownFiles) {
    const filePath = join(promptsDir, fileName);
    const content = await readFile(filePath, 'utf-8');

    let rawFrontmatter: string;
    let body: string;
    try {
      ({ rawFrontmatter, body } = splitFrontmatterAndBody(content));
    } catch (error) {
      throw new PromptParseError(
        filePath,
        error instanceof Error ? error.message : String(error),
      );
    }

    let parsedYaml: unknown;
    try {
      parsedYaml = parseYaml(rawFrontmatter);
    } catch (error) {
      throw new PromptParseError(
        filePath,
        `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const validationResult = PromptFrontmatterSchema.safeParse(parsedYaml);
    if (!validationResult.success) {
      throw new PromptParseError(
        filePath,
        `Schema validation failed: ${validationResult.error.message}`,
      );
    }

    prompts.push({
      frontmatter: validationResult.data,
      body,
      filePath,
    });
  }

  // Sort by id
  prompts.sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));

  return prompts;
}
