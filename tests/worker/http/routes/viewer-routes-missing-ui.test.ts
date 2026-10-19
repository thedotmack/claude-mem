import { describe, it, expect, afterEach } from 'bun:test';
import type { Response } from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { lazyUiHtml, sendUiMissingPage } from '../../../../src/services/worker/http/routes/ViewerRoutes.js';

/**
 * A worker can outlive its plugin folder, for example when an update replaces
 * the cache directory. The UI routes must not remember a miss for the life of
 * the process, and a miss must not reach error tracking on every page load.
 */
describe('lazyUiHtml', () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('checks the disk again after a miss, so the page recovers without a restart', () => {
    root = mkdtempSync(path.join(tmpdir(), 'cmem-ui-'));
    const read = lazyUiHtml('work-view/index.html', () => root);

    expect(read()).toBeNull();

    mkdirSync(path.join(root, 'plugin', 'ui', 'work-view'), { recursive: true });
    writeFileSync(path.join(root, 'plugin', 'ui', 'work-view', 'index.html'), '<p>my work</p>');

    expect(read()?.toString()).toBe('<p>my work</p>');
  });

  it('keeps serving the cached bytes after a successful read', () => {
    root = mkdtempSync(path.join(tmpdir(), 'cmem-ui-'));
    mkdirSync(path.join(root, 'ui'), { recursive: true });
    writeFileSync(path.join(root, 'ui', 'viewer.html'), '<p>viewer</p>');
    const read = lazyUiHtml('viewer.html', () => root);

    expect(read()?.toString()).toBe('<p>viewer</p>');

    rmSync(path.join(root, 'ui'), { recursive: true, force: true });

    expect(read()?.toString()).toBe('<p>viewer</p>');
  });
});

describe('sendUiMissingPage', () => {
  it('serves a 503 restart page instead of a 500', () => {
    const headers: Record<string, string> = {};
    let status = 0;
    let html = '';
    const res = {
      status: (code: number) => { status = code; return res; },
      setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
      send: (body: string) => { html = body; },
    } as unknown as Response;

    sendUiMissingPage(res, 'My Work');

    expect(status).toBe(503);
    expect(headers['content-type']).toContain('text/html');
    expect(headers['cache-control']).toBe('no-store');
    expect(html).toContain('My Work files are missing');
    expect(html).toContain('href="/restart"');
  });
});
