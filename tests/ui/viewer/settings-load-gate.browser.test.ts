import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);

if (process.env.CI && !chrome) {
  throw new Error('CI requires Chrome or Chromium for the settings load-gate regressions.');
}

// Until GET /api/settings succeeds the form holds DEFAULT_SETTINGS. A save
// then would post those defaults over settings.json: provider, worker port,
// and blank API keys. Save has to wait for the load, and a failed load offers
// Retry instead of a save.
for (const scenario of ['held', 'failed'] as const) {
  (chrome ? it : it.skip)(`keeps Save from posting defaults while the settings load is ${scenario}`, async () => {
    // The one-shot compiler exits before Chrome starts, keeping the browser
    // phase free of shared esbuild service handles.
    const esbuildBinary = createRequire(import.meta.url).resolve(
      `@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`
    );
    const bundle = execFileSync(esbuildBinary, [
      '--bundle', '--loader=tsx', '--platform=browser', '--format=iife',
      '--define:process.env.NODE_ENV="production"', '--log-level=error',
    ], {
      cwd: resolve(import.meta.dir, '../../..'),
      input: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ContextSettingsModal } from './src/ui/viewer/components/ContextSettingsModal';
        import { useSettings } from './src/ui/viewer/hooks/useSettings';
        function Fixture() {
          const state = useSettings();
          return <ContextSettingsModal isOpen={true} onClose={() => {}} onSave={state.saveSettings}
            settings={state.settings} isLoaded={state.isLoaded} loadError={state.loadError}
            onRetryLoad={state.reload} isSaving={state.isSaving} saveStatus={state.saveStatus} />;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
        async function until(predicate, what) {
          const deadline = Date.now() + 6000;
          while (!predicate()) {
            if (Date.now() > deadline) throw new Error(what + ' did not happen');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        async function settle() { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); }
        const save = () => document.querySelector('.save-btn');
        const observations = () => [...document.querySelectorAll('.form-field')]
          .find(field => field.textContent.startsWith('Observations'))?.querySelector('input');
        const status = () => document.querySelector('.save-status').textContent;
        const snapshot = () => ({ saveDisabled: save().disabled, inputDisabled: observations().matches(':disabled'),
          observations: observations().value, status: status() });
        let blocked;
        (async () => {
          try {
            await fetch('/ready');
            await until(() => save() && observations(), 'Settings render');
            // The server now holds the first GET, or has answered it with a 500.
            await fetch('/first-load-seen');
            // Wait for the load status, but take the snapshot and click Save
            // even without it, so a build that lets Save through shows its POST.
            await until(() => status().includes(${scenario === 'held' ? "'Loading settings'" : "'Could not load settings'"}), 'Load status').catch(() => {});
            const retry = [...document.querySelectorAll('.save-status button')].find(button => button.textContent === 'Retry');
            blocked = { ...snapshot(), retry: !!retry };
            save().click(); await settle();
            if (${scenario === 'held'}) await fetch('/release-load');
            else if (retry) retry.click();
            else throw new Error('No Retry after the failed load');
            await until(() => !save().disabled && observations().value === '7', 'Settings load');
            await settle();
            const loaded = snapshot();
            save().click();
            await until(() => status().includes('Saved'), 'Save');
            await fetch('/result', { method: 'POST', body: JSON.stringify({ blocked, loaded }) });
          } catch (error) { await fetch('/result', { method: 'POST', body: JSON.stringify({ blocked, failure: String(error) }) }); }
        })();
      `,
      encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024,
    });
    const stored = { CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_MEM_CONTEXT_OBSERVATIONS: '7', CLAUDE_MEM_WORKER_PORT: '41234' };
    const posts: any[] = [];
    let postsWhenLoaded: number | null = null;
    let loads = 0;
    let releaseLoad!: () => void;
    const loadReleased = new Promise<void>(resolve => { releaseLoad = resolve; });
    let markFirstLoad!: () => void;
    const firstLoadSeen = new Promise<void>(resolve => { markFirstLoad = resolve; });
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    let report!: (value: unknown) => void;
    const result = new Promise<any>(resolve => { report = resolve; });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/fixture.js') return new Response(bundle, { headers: { 'Content-Type': 'application/javascript' } });
      if (path === '/ready') { markReady(); return new Response('ready'); }
      if (path === '/api/settings' && request.method === 'POST') { posts.push(await request.json()); return Response.json({ success: true }); }
      if (path === '/api/settings') {
        loads++;
        markFirstLoad();
        if (scenario === 'failed' && loads === 1) return new Response('settings outage', { status: 500 });
        if (scenario === 'held') await loadReleased;
        postsWhenLoaded = posts.length;
        return Response.json(stored);
      }
      if (path === '/first-load-seen') { await firstLoadSeen; return new Response('seen'); }
      if (path === '/release-load') { releaseLoad(); return new Response('released'); }
      if (path === '/api/projects') return Response.json({ projects: [], sources: [], projectsBySource: {} });
      if (path === '/result') { report(await request.json()); return new Response('received'); }
      return new Response('<div id="root"></div><script src="/fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
    } });
    const profile = mkdtempSync(join(tmpdir(), 'claude-mem-settings-load-gate-'));
    const child = Bun.spawn([chrome!, '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run',
      `--user-data-dir=${profile}`, server.url.href], { stdout: 'ignore', stderr: 'ignore' });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Separate Chrome startup from the fixture's own load and save steps.
      await Promise.race([ready, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Settings browser did not become ready')), 30000);
      })]);
      clearTimeout(timeout);
      const reported = await Promise.race([result, new Promise(resolve => {
        timeout = setTimeout(() => resolve({ failure: 'Settings fixture timed out' }), 25000);
      })]);
      // Before the load: the form and Save are disabled, and a Save click
      // posts nothing (it would have posted the defaults).
      expect({ ...reported.blocked, postsBeforeLoad: posts.slice(0, postsWhenLoaded ?? posts.length) }).toEqual({
        saveDisabled: true, inputDisabled: true, observations: '50',
        status: scenario === 'held' ? 'Loading settings…' : 'Could not load settings: HTTP 500 Retry',
        retry: scenario === 'failed', postsBeforeLoad: [],
      });
      expect(reported.failure).toBeUndefined();
      expect(reported.loaded).toEqual({ saveDisabled: false, inputDisabled: false, observations: '7', status: '' });
      expect(loads).toBe(scenario === 'failed' ? 2 : 1);
      // The one POST comes after the load. Nothing was edited, so it carries
      // nothing to write: neither the defaults nor an echo of the loaded values
      // that could put back a change made elsewhere since (#4597).
      expect(postsWhenLoaded).toBe(0);
      expect(posts).toEqual([{}]);
    } finally {
      clearTimeout(timeout); releaseLoad(); child.kill(); await child.exited; server.stop(true);
      rmSync(profile, { recursive: true, force: true });
    }
  }, 80000);
}
