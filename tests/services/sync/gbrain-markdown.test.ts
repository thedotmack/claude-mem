import { describe, expect, it } from 'bun:test';
import {
  GbrainObservationSource,
  observationSlug,
  renderObservationMarkdown,
} from '../../../src/services/sync/GbrainMarkdown.js';

// No YAML parser is a project dependency (package.json only carries the
// tree-sitter YAML *grammar*), so frontmatter assertions are string-shape
// based, plus a manual single-quoted-scalar unescape round-trip.

function makeSource(overrides: Partial<GbrainObservationSource> = {}): GbrainObservationSource {
  return {
    id: 42,
    project: 'my-project',
    memorySessionId: 'mem-session-1',
    type: 'discovery',
    title: 'Found the bug',
    subtitle: 'It was the cache',
    narrative: 'The cache was stale because the key never rotated.',
    facts: ['Fact one', 'Fact two'],
    concepts: ['caching', 'debugging'],
    filesRead: ['src/a.ts', 'src/b.ts'],
    filesModified: ['src/a.ts'],
    createdAtEpoch: 1_700_000_000_000,
    ...overrides,
  };
}

/** Extract the frontmatter block (between the first two '---' lines). */
function frontmatterOf(markdown: string): string[] {
  const lines = markdown.split('\n');
  expect(lines[0]).toBe('---');
  const end = lines.indexOf('---', 1);
  expect(end).toBeGreaterThan(0);
  return lines.slice(1, end);
}

/** Reverse of yamlQuote for a single-quoted YAML scalar. */
function unquoteYamlScalar(quoted: string): string {
  expect(quoted.startsWith("'")).toBe(true);
  expect(quoted.endsWith("'")).toBe(true);
  return quoted.slice(1, -1).replace(/''/g, "'");
}

describe('renderObservationMarkdown frontmatter', () => {
  it('emits type: note, title, tags, and the claude_mem block', () => {
    const source = makeSource();
    const markdown = renderObservationMarkdown(source);
    const fm = frontmatterOf(markdown);

    expect(fm).toContain('type: note');
    expect(fm).toContain("title: 'Found the bug'");
    expect(fm).toContain("tags: ['caching', 'debugging']");
    expect(fm).toContain('claude_mem:');
    expect(fm).toContain('  observation_id: 42');
    expect(fm).toContain("  project: 'my-project'");
    expect(fm).toContain("  obs_type: 'discovery'");
    expect(fm).toContain("  memory_session_id: 'mem-session-1'");
    expect(fm).toContain(`  created_at: '${new Date(1_700_000_000_000).toISOString()}'`);
    expect(fm).toContain("  files_read: ['src/a.ts', 'src/b.ts']");
    expect(fm).toContain("  files_modified: ['src/a.ts']");
  });

  it('omits tags and files lines when the source lists are empty', () => {
    const markdown = renderObservationMarkdown(makeSource({
      concepts: [],
      filesRead: [],
      filesModified: [],
    }));
    const fm = frontmatterOf(markdown);

    expect(fm.some(line => line.startsWith('tags:'))).toBe(false);
    expect(fm.some(line => line.trimStart().startsWith('files_read:'))).toBe(false);
    expect(fm.some(line => line.trimStart().startsWith('files_modified:'))).toBe(false);
  });

  it('falls back to Untitled when title is null', () => {
    const markdown = renderObservationMarkdown(makeSource({ title: null }));
    expect(frontmatterOf(markdown)).toContain("title: 'Untitled'");
    expect(markdown).toContain('## [DISCOVERY] Untitled');
  });

  it('escapes single quotes and flattens newlines so the scalar round-trips', () => {
    const title = "It's a 'quoted' title: with #special {chars}";
    const markdown = renderObservationMarkdown(makeSource({ title }));
    const fm = frontmatterOf(markdown);
    const titleLine = fm.find(line => line.startsWith('title: '));
    expect(titleLine).toBeDefined();
    expect(titleLine).toBe("title: 'It''s a ''quoted'' title: with #special {chars}'");
    expect(unquoteYamlScalar(titleLine!.slice('title: '.length))).toBe(title);

    const multiline = renderObservationMarkdown(makeSource({
      project: "line one\nline 'two'",
    }));
    const projectLine = frontmatterOf(multiline).find(line => line.startsWith('  project: '));
    expect(projectLine).toBe("  project: 'line one line ''two'''");
    expect(unquoteYamlScalar(projectLine!.slice('  project: '.length))).toBe("line one line 'two'");
  });
});

describe('renderObservationMarkdown body (CorpusRenderer conventions)', () => {
  it('renders header, date/project line, subtitle blockquote, narrative, facts, concepts, files', () => {
    const markdown = renderObservationMarkdown(makeSource());
    const body = markdown.split('\n---\n')[1] ?? '';

    expect(body).toContain('## [DISCOVERY] Found the bug');
    expect(body).toContain('*2023-11-14* | Project: my-project');
    expect(body).toContain('> It was the cache');
    expect(body).toContain('The cache was stale because the key never rotated.');
    expect(body).toContain('**Facts:**\n- Fact one\n- Fact two');
    expect(body).toContain('**Concepts:** caching, debugging');
    expect(body).toContain('**Files Read:** src/a.ts, src/b.ts');
    expect(body).toContain('**Files Modified:** src/a.ts');
  });

  it('omits body sections that have no content', () => {
    const markdown = renderObservationMarkdown(makeSource({
      subtitle: null,
      narrative: null,
      facts: [],
      concepts: [],
      filesRead: [],
      filesModified: [],
    }));
    const body = markdown.split('\n---\n')[1] ?? '';

    expect(body).not.toContain('> ');
    expect(body).not.toContain('**Facts:**');
    expect(body).not.toContain('**Concepts:**');
    expect(body).not.toContain('**Files Read:**');
    expect(body).not.toContain('**Files Modified:**');
  });
});

describe('observationSlug', () => {
  it('is deterministic', () => {
    const a = observationSlug('claude-mem', 'my-project', 7);
    const b = observationSlug('claude-mem', 'my-project', 7);
    expect(a).toBe(b);
    expect(a).toBe('claude-mem/my-project/obs-7');
  });

  it('sanitizes spaces, slashes, and unicode to a stable slug', () => {
    expect(observationSlug('claude-mem', 'My Project/Näme', 42))
      .toBe('claude-mem/my-project/n-me/obs-42');
    // Deterministic across calls for the messy input too.
    expect(observationSlug('claude-mem', 'My Project/Näme', 42))
      .toBe(observationSlug('claude-mem', 'My Project/Näme', 42));
  });

  it('respects a custom prefix, including multi-segment prefixes', () => {
    expect(observationSlug('team/mem', 'proj', 1)).toBe('team/mem/proj/obs-1');
    expect(observationSlug('Custom Prefix', 'proj', 1)).toBe('custom-prefix/proj/obs-1');
  });

  it('drops segments that sanitize to nothing and trims edge punctuation', () => {
    expect(observationSlug('claude-mem', '///', 3)).toBe('claude-mem/obs-3');
    expect(observationSlug('claude-mem', '..hidden..', 3)).toBe('claude-mem/hidden/obs-3');
    expect(observationSlug('claude-mem', 'A  B   C', 3)).toBe('claude-mem/a-b-c/obs-3');
  });

  it('output is a fixed point of its own sanitizer (import lane matches capture lane)', () => {
    const slug = observationSlug('claude-mem', 'My Project/Näme', 42);
    for (const segment of slug.split('/')) {
      expect(segment).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      // Re-slugifying an already-sanitized segment must not change it.
      expect(segment.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, ''))
        .toBe(segment);
    }
  });
});
