/**
 * Tests for TerminalPreview component
 *
 * Since @testing-library/react is not installed, we test:
 * 1. sanitizeAnsiHtml — the exported XSS defense-in-depth sanitizer
 * 2. Module smoke test — component can be imported
 *
 * Visual / interaction behaviour is covered by Playwright E2E tests.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeAnsiHtml } from '../../../src/ui/viewer/components/TerminalPreview';

// ---------------------------------------------------------------------------
// sanitizeAnsiHtml — allowlist sanitizer tests
// ---------------------------------------------------------------------------

describe('sanitizeAnsiHtml', () => {
  it('allows plain <span style="..."> tags', () => {
    const input = '<span style="color:#ff0000">text</span>';
    expect(sanitizeAnsiHtml(input)).toBe(input);
  });

  it('allows <span class="..."> tags', () => {
    const input = '<span class="ansi-red">text</span>';
    expect(sanitizeAnsiHtml(input)).toBe(input);
  });

  it('allows <span> with both style and class attributes', () => {
    const input = '<span style="color:#ff0000" class="ansi-red">text</span>';
    expect(sanitizeAnsiHtml(input)).toBe(input);
  });

  it('strips <script> tags by escaping them', () => {
    const input = '<script>alert("xss")</script>';
    const result = sanitizeAnsiHtml(input);
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('strips <img> tags by escaping them', () => {
    const input = '<img src="x" onerror="alert(1)">';
    const result = sanitizeAnsiHtml(input);
    expect(result).not.toContain('<img');
    expect(result).toContain('&lt;img');
  });

  it('strips <a> tags by escaping them', () => {
    const input = '<a href="javascript:alert(1)">click</a>';
    const result = sanitizeAnsiHtml(input);
    expect(result).not.toContain('<a ');
    expect(result).toContain('&lt;a');
  });

  it('strips <div> tags by escaping them', () => {
    const input = '<div onclick="alert(1)">text</div>';
    const result = sanitizeAnsiHtml(input);
    expect(result).not.toContain('<div');
    expect(result).toContain('&lt;div');
  });

  it('strips <iframe> tags by escaping them', () => {
    const input = '<iframe src="evil.com"></iframe>';
    const result = sanitizeAnsiHtml(input);
    expect(result).not.toContain('<iframe');
    expect(result).toContain('&lt;iframe');
  });

  it('preserves plain text without tags', () => {
    const input = 'Hello world, this is plain text';
    expect(sanitizeAnsiHtml(input)).toBe(input);
  });

  it('preserves already-escaped HTML entities', () => {
    const input = '&lt;script&gt;alert(1)&lt;/script&gt;';
    expect(sanitizeAnsiHtml(input)).toBe(input);
  });

  it('handles empty string', () => {
    expect(sanitizeAnsiHtml('')).toBe('');
  });

  it('handles mixed allowed and disallowed tags', () => {
    const input = '<span style="color:red">ok</span><script>bad</script><span class="x">ok2</span>';
    const result = sanitizeAnsiHtml(input);
    expect(result).toContain('<span style="color:red">ok</span>');
    expect(result).toContain('<span class="x">ok2</span>');
    expect(result).not.toContain('<script>');
  });

  it('strips <span> with onclick attribute (not in allowlist)', () => {
    const input = '<span onclick="alert(1)">text</span>';
    const result = sanitizeAnsiHtml(input);
    // The opening tag should be escaped, closing </span> is still allowed
    expect(result).toContain('&lt;span onclick=');
  });
});

// ---------------------------------------------------------------------------
// TerminalPreview module — smoke test
// ---------------------------------------------------------------------------

describe('TerminalPreview module', () => {
  it('exports TerminalPreview as a named export', async () => {
    const mod = await import('../../../src/ui/viewer/components/TerminalPreview');
    expect(typeof mod.TerminalPreview).toBe('function');
  });

  it('exports sanitizeAnsiHtml as a named export', async () => {
    const mod = await import('../../../src/ui/viewer/components/TerminalPreview');
    expect(typeof mod.sanitizeAnsiHtml).toBe('function');
  });
});
