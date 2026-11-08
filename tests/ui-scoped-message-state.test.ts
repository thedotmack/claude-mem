import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { interpolate } from '../src/ui/i18n/locale.ts';
import { setupZh } from '../src/ui/i18n/setup-zh.ts';
import { viewerZh } from '../src/ui/i18n/viewer-zh.ts';

const require = createRequire(import.meta.url);
const catalog = { ...setupZh, ...viewerZh };

// Exercise real handlers and state across rerenders without a DOM or global module mocks.
async function fixture(path: string, exportName: string) {
  let cursor = 0;
  let locale = 'en';
  let state: any[] = [];
  const componentStates = new Map<Function, any[]>();
  const runtime = {
    useState(initial: any) {
      const slot = cursor++;
      const slots = state;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], (value: any) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }];
    },
    useRef: (value: any) => runtime.useState(() => ({ current: value }))[0],
    useEffect() {},
    useMemo: (compute: () => unknown) => compute(),
    useCallback: (callback: unknown) => callback,
    useI18n: () => ({ t: (s: string) => locale === 'en' ? s : catalog[s] ?? s, locale }),
    getLocale: () => locale,
    interpolate,
  };
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    tsconfig: fileURLToPath(new URL('../src/ui/my-work/tsconfig.app.json', import.meta.url)),
    bundle: true, write: false, platform: 'node', format: 'cjs',
    loader: { '.webp': 'dataurl' }, external: ['__runtime', '__react'],
    plugins: [{ name: 'isolated-hooks', setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fixture' }));
      build.onResolve({ filter: /\/i18n$/ }, () => ({ path: 'i18n', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'react'
        ? `export * from '__react'; export {default} from '__react'; export const {useState,useRef,useEffect,useMemo,useCallback}=require('__runtime');`
        : `export const {useI18n,getLocale,interpolate}=require('__runtime');` }));
    } }],
  });
  const module = { exports: {} as any };
  new Function('module', 'exports', 'require', 'window', 'requestAnimationFrame', compiled.outputFiles[0].text)(module, module.exports,
    (id: string) => id === '__runtime' ? runtime : require(id === '__react' ? 'react' : id), { innerHeight: 900 }, () => 0);
  return {
    language(value: string) { locale = value; },
    render(props: any, component = module.exports[exportName]) {
      cursor = 0;
      if (!componentStates.has(component)) componentStates.set(component, []);
      state = componentStates.get(component)!;
      return component(props);
    },
  };
}

function find(tree: any, predicate: (element: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return;
  if (predicate(tree)) return tree;
  for (const child of [tree.props?.children].flat(Infinity)) {
    const found = find(child, predicate);
    if (found) return found;
  }
}
const byClass = (tree: any, name: string) => find(tree, e => e.props?.className === name);

test('workspace search and save statuses rerender in the selected language; raw errors stay verbatim', async () => {
  const ui = await fixture('../src/ui/my-work/src/setup/screens/workspace-screen.tsx', 'WorkspaceScreen');
  const record = { id: 1, title: 'Other {count}', body: '$& {error}', project: 'Other', agent: 'Agent', session: 'Session', date: '2026-11-03' };
  let fail = false;
  const props = { suggestions: ['Other'], search: async () => {
    if (fail) throw new Error('Note saved.');
    return [record];
  }, keepNote: async () => 2, forgetNote: async () => {}, onContinue() {} };
  let tree = ui.render(props);
  const search = find(tree, e => e.type === 'button' && e.props.children === 'Other').props.onClick;
  await search();
  // Suggestion clicks intentionally fire-and-forget the asynchronous search.
  await new Promise(resolve => setImmediate(resolve));
  tree = ui.render(props);
  assert.equal(byClass(tree, 'workspace-status').props.children, '1 memory found across your projects.');
  ui.language('zh-CN');
  tree = ui.render(props);
  assert.equal(byClass(tree, 'workspace-status').props.children, setupZh['1 memory found across your projects.']);
  const card = find(tree, e => e.props?.record?.id === 1);
  assert.equal(card.props.record.body, '$& {error}');
  await card.props.onKeep();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(byClass(ui.render(props), 'workspace-status').props.children, setupZh['Kept as a note in your memory.']);
  ui.language('en');
  assert.equal(byClass(ui.render(props), 'workspace-status').props.children, 'Kept as a note in your memory.');
  fail = true;
  search();
  await new Promise(resolve => setImmediate(resolve));
  ui.language('zh-CN');
  assert.equal(byClass(ui.render(props), 'workspace-status').props.children, 'Note saved.');
});

test('logs fetch and clear errors translate at render time without refetching', async () => {
  const ui = await fixture('../src/ui/viewer/components/LogsModal.tsx', 'LogsDrawer');
  const originalFetch = globalThis.fetch;
  const originalConfirm = globalThis.confirm;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return { ok: false, statusText: '$& {reason}' }; }) as any;
  globalThis.confirm = () => true;
  const props = { isOpen: true, onClose() {} };
  const errorText = () => byClass(ui.render(props), 'console-error').props.children.join('');
  try {
    await find(ui.render(props), e => e.props?.title === 'Refresh logs').props.onClick();
    assert.match(errorText(), /Failed to fetch logs: \$& \{reason\}/);
    ui.language('zh-CN');
    assert.match(errorText(), /获取日志失败：\$& \{reason\}/);
    assert.equal(requests, 1);
    await find(ui.render(props), e => e.props?.title === viewerZh['Clear logs']).props.onClick();
    assert.match(errorText(), /清除日志失败：\$& \{reason\}/);
    ui.language('en');
    assert.match(errorText(), /Failed to clear logs: \$& \{reason\}/);
    assert.equal(requests, 2);
  } finally { globalThis.fetch = originalFetch; globalThis.confirm = originalConfirm; }
});

test('workspace pending, plural and empty results translate without repeating the search', async () => {
  const ui = await fixture('../src/ui/my-work/src/setup/screens/workspace-screen.tsx', 'WorkspaceScreen');
  let complete!: (records: any[]) => void;
  let requests = 0;
  const props = { suggestions: ['query'], search: () => {
    requests++;
    return new Promise<any[]>(resolve => { complete = resolve; });
  }, keepNote: async () => 1, forgetNote: async () => {}, onContinue() {} };
  const search = find(ui.render(props), e => e.type === 'button' && e.props.children === 'query').props.onClick;
  const status = () => byClass(ui.render(props), 'workspace-status').props.children;
  search();
  assert.equal(status(), 'Searching your memory…');
  ui.language('zh-CN');
  assert.equal(status(), setupZh['Searching your memory…']);
  complete([{ id: 1 }, { id: 2 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(status(), interpolate(setupZh['{count} memories found across your projects.'], { count: 2 }));
  ui.language('en');
  assert.equal(status(), '2 memories found across your projects.');
  assert.equal(requests, 1);
  search();
  complete([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(status(), 'No matching memories found.');
  ui.language('zh-CN');
  assert.equal(status(), setupZh['No matching memories found.']);
  assert.equal(requests, 2);
});

test('a stale log failure cannot overwrite a newer response after switching languages', async () => {
  const ui = await fixture('../src/ui/viewer/components/LogsModal.tsx', 'LogsDrawer');
  const originalFetch = globalThis.fetch;
  const pending: ((value: any) => void)[] = [];
  globalThis.fetch = (() => new Promise(resolve => pending.push(resolve))) as any;
  const props = { isOpen: true, onClose() {} };
  const refresh = () => find(ui.render(props), e => e.props?.title === (uiLocale === 'en' ? 'Refresh logs' : viewerZh['Refresh logs'])).props.onClick();
  let uiLocale = 'en';
  try {
    const older = refresh();
    uiLocale = 'zh-CN';
    ui.language(uiLocale);
    const newer = refresh();
    pending[1]({ ok: false, statusText: 'NEW {reason} $&' });
    await newer;
    pending[0]({ ok: false, statusText: 'OLD' });
    await older;
    assert.equal(pending.length, 2);
    assert.match(byClass(ui.render(props), 'console-error').props.children.join(''), /获取日志失败：NEW \{reason\} \$&/);
    ui.language('en');
    assert.match(byClass(ui.render(props), 'console-error').props.children.join(''), /Failed to fetch logs: NEW \{reason\} \$&/);
  } finally { globalThis.fetch = originalFetch; }
});

for (const copied of [true, false]) {
  test(`setup clipboard ${copied ? 'success' : 'failure'} status switches languages`, async () => {
    const ui = await fixture('../src/ui/my-work/src/setup/screens/finish-setup-screen.tsx', 'FinishSetupScreen');
    const props = { branch: 'go', tools: [{ id: 'tool', name: 'Other', mark: 'terminal', kind: 'mcp', guide: { href: '#', label: 'Guide' } }], selected: ['tool'], history: null, importStatus: 'none', importResult: null };
    const connection = find(ui.render(props), e => e.type?.name === 'Connection');
    const copyUrl = find(ui.render(connection.props, connection.type), e => e.type?.name === 'CopyUrl');
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { async writeText() { if (!copied) throw Error('denied'); } } } });
    try {
      const render = () => ui.render(copyUrl.props, copyUrl.type);
      assert.equal(await find(render(), e => typeof e.props?.onClick === 'function').props.onClick(), copied);
      const key = copied ? 'URL copied.' : 'Select and copy the URL above.';
      assert.equal(byClass(render(), 'connection-status').props.children, key);
      ui.language('zh-CN');
      assert.equal(byClass(render(), 'connection-status').props.children, setupZh[key]);
      ui.language('en');
      assert.equal(byClass(render(), 'connection-status').props.children, key);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });
}
