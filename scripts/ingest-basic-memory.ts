#!/usr/bin/env bun
/**
 * Ingest markdown files from basic-memory into claude-mem
 * Usage: bun scripts/ingest-basic-memory.ts /path/to/basic-memory
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, basename, dirname, relative } from 'path';

const WORKER_URL = 'http://localhost:37777';

interface Observation {
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  discovery_tokens: number;
  created_at: string;
  created_at_epoch: number;
}

interface Session {
  content_session_id: string;
  memory_session_id: string;
  project: string;
  user_prompt: string;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: string;
}

function parseMarkdownFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter: Record<string, any> = {};
  const lines = frontmatterMatch[1].split('\n');
  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      let value = match[2].trim();
      // Handle arrays
      if (value.startsWith('[') || value.startsWith('-')) {
        continue; // Skip complex values for now
      }
      frontmatter[match[1]] = value;
    }
  }

  return { frontmatter, body: frontmatterMatch[2] };
}

function getFileModTime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return Date.now();
  }
}

function extractTitle(body: string, filename: string): string {
  // Try to extract from first H1
  const h1Match = body.match(/^#\s+(.+)$/m);
  if (h1Match) {
    return h1Match[1].trim();
  }
  // Fall back to filename
  return basename(filename, '.md').replace(/-/g, ' ');
}

function mapTypeFromTags(tags: string | undefined, title: string): string {
  // Valid types: decision, bugfix, feature, refactor, discovery, change
  const lowerTitle = title.toLowerCase();
  if (lowerTitle.includes('bug') || lowerTitle.includes('fix')) return 'bugfix';
  if (lowerTitle.includes('feature')) return 'feature';
  if (lowerTitle.includes('decision')) return 'decision';
  if (lowerTitle.includes('refactor')) return 'refactor';
  if (lowerTitle.includes('change') || lowerTitle.includes('update') || lowerTitle.includes('add')) return 'change';
  return 'discovery';
}

function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden directories
        if (!entry.name.startsWith('.')) {
          walk(fullPath);
        }
      } else if (entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

async function main() {
  const basicMemoryPath = process.argv[2] || '/Users/saint/basic-memory';

  console.log(`\n📂 Scanning ${basicMemoryPath}...\n`);

  const files = findMarkdownFiles(basicMemoryPath);
  console.log(`Found ${files.length} markdown files\n`);

  // Group files by project (top-level directory)
  const projectFiles = new Map<string, string[]>();
  for (const file of files) {
    const relPath = relative(basicMemoryPath, file);
    const project = relPath.split('/')[0] || 'basic-memory';
    if (!projectFiles.has(project)) {
      projectFiles.set(project, []);
    }
    projectFiles.get(project)!.push(file);
  }

  console.log(`Projects: ${Array.from(projectFiles.keys()).join(', ')}\n`);

  const sessions: Session[] = [];
  const observations: Observation[] = [];

  // Create sessions and observations for each project
  for (const [project, projectFileList] of projectFiles) {
    const sessionId = `basic-memory-import-${project}-${Date.now()}`;
    const now = Date.now();

    // Create a session for this project
    sessions.push({
      content_session_id: sessionId,
      memory_session_id: sessionId,
      project: project,
      user_prompt: `Imported from basic-memory/${project}`,
      started_at: new Date(now).toISOString(),
      started_at_epoch: now,
      completed_at: new Date(now).toISOString(),
      completed_at_epoch: now,
      status: 'completed'
    });

    // Create observations for each file
    for (const filePath of projectFileList) {
      const content = readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = parseMarkdownFrontmatter(content);
      const relPath = relative(basicMemoryPath, filePath);
      const modTime = getFileModTime(filePath);

      const title = frontmatter.title || extractTitle(body, filePath);
      const type = mapTypeFromTags(frontmatter.tags, title);

      observations.push({
        memory_session_id: sessionId,
        project: project,
        text: body.slice(0, 10000), // Limit text size
        type: type,
        title: title,
        subtitle: relPath,
        facts: null,
        narrative: body.slice(0, 2000),
        concepts: frontmatter.tags || null,
        files_read: relPath,
        files_modified: null,
        prompt_number: null,
        discovery_tokens: Math.ceil(body.length / 4),
        created_at: new Date(modTime).toISOString(),
        created_at_epoch: modTime
      });
    }

    console.log(`  ${project}: ${projectFileList.length} files`);
  }

  console.log(`\n📤 Importing ${sessions.length} sessions and ${observations.length} observations...\n`);

  // Send to claude-mem API
  const response = await fetch(`${WORKER_URL}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessions,
      observations,
      summaries: [],
      prompts: []
    })
  });

  if (!response.ok) {
    console.error(`❌ Import failed: ${response.status} ${response.statusText}`);
    const text = await response.text();
    console.error(text);
    process.exit(1);
  }

  const result = await response.json();
  console.log('✅ Import complete!\n');
  console.log(`Sessions: ${result.stats.sessionsImported} imported, ${result.stats.sessionsSkipped} skipped`);
  console.log(`Observations: ${result.stats.observationsImported} imported, ${result.stats.observationsSkipped} skipped`);
}

main().catch(console.error);
