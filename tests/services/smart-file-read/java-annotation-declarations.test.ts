import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatFoldedView, parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

describe('Java annotation declarations', () => {
  for (const ending of ['\n', '\r\n']) {
    test(`keeps the annotation declaration after array-valued meta-annotations (${JSON.stringify(ending)})`, () => {
      const source = [
        '@Target({',
        '  ElementType.TYPE, ElementType.METHOD',
        '})',
        '@Retention(RetentionPolicy.RUNTIME)',
        'public @interface Api {',
        '  String value();',
        '}',
      ].join(ending);
      const parsed = parseFile(source, 'Api.java');
      expect(parsed.symbols[0]?.signature).toBe('@Target({ ElementType.TYPE, ElementType.METHOD }) @Retention(RetentionPolicy.RUNTIME) public @interface Api');
      expect(formatFoldedView(parsed)).toContain('public @interface Api');
      expect(parsed.symbols[0]?.signature).not.toContain('String value()');
      expect(unfoldSymbol(source, 'Api.java', 'Api')).toContain(source);
    }, 120000);
  }

  test('includes the full meta-annotated type header in native search results', async () => {
    const source = '@Target({ElementType.TYPE})\npublic @interface Api {\n  String value();\n}';
    const directory = mkdtempSync(join(tmpdir(), 'owned-java-annotation-header-'));
    try {
      writeFileSync(join(directory, 'Api.java'), source);
      const result = await searchCodebase(directory, 'Api');
      const api = result.matchingSymbols.find(symbol => symbol.symbolName === 'Api');
      expect(api?.signature).toBe('@Target({ElementType.TYPE}) public @interface Api');
      expect(unfoldSymbol(source, 'Api.java', api!.symbolName)).toContain(source);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 120000);

  test('retains a documented marker annotation as an interface', () => {
    const source = '/** Marks an owned API. */\npublic @interface Owned {}\nclass Adjacent {}';
    const parsed = parseFile(source, 'Owned.java');
    expect(parsed.symbols.map(symbol => [symbol.name, symbol.kind])).toEqual([
      ['Owned', 'interface'], ['Adjacent', 'class'],
    ]);
    expect(parsed.symbols[0].signature).toBe('public @interface Owned');
    expect(parsed.symbols[0].jsdoc).toContain('Marks an owned API');
    expect(formatFoldedView(parsed)).toContain('public @interface Owned');
    const unfolded = unfoldSymbol(source, 'Owned.java', 'Owned');
    expect(unfolded).toContain('public @interface Owned {}');
    expect(unfolded).not.toContain('class Adjacent');
  }, 120000);

  test('keeps element signatures including defaults containing braces and annotations', () => {
    const declarations = [
      'String value();',
      'boolean enabled() default true;',
      'Class<?> owner() default Object.class;',
      'Mode mode() default Mode.SAFE;',
      'String[] tags() default {"fast", "safe"};',
      'Nested nested() default @Nested("ready");',
    ];
    const source = ['public @interface Api {', ...declarations.map(line => '  ' + line), '}'].join('\n');
    const api = parseFile(source, 'Api.java').symbols[0];
    expect(api?.name).toBe('Api');
    expect(api?.children?.map(symbol => symbol.kind)).toEqual(declarations.map(() => 'method'));
    expect(api?.children?.map(symbol => symbol.signature)).toEqual(declarations);
    const tags = unfoldSymbol(source, 'Api.java', 'Api.tags');
    expect(tags).toContain('String[] tags() default {"fast", "safe"};');
    expect(tags).not.toContain('Nested nested()');
    const nested = unfoldSymbol(source, 'Api.java', 'Api.nested');
    expect(nested).toContain('Nested nested() default @Nested("ready");');
    expect(nested).not.toContain('String[] tags()');
  }, 120000);

  test('gives equal-named elements their nearest annotation owner', () => {
    const source = [
      'class Envelope {',
      '  @interface Local {',
      '    String value() default "local";',
      '  }',
      '  @interface Remote {',
      '    String value() default "remote";',
      '  }',
      '  String value() { return "method"; }',
      '}',
    ].join('\n');
    const envelope = parseFile(source, 'Envelope.java').symbols[0];
    expect(envelope.children?.map(symbol => symbol.name)).toEqual(['Local', 'Remote', 'value']);
    expect(envelope.children?.slice(0, 2).map(symbol => symbol.children?.map(child => child.name))).toEqual([['value'], ['value']]);
    const local = unfoldSymbol(source, 'Envelope.java', 'Envelope.Local.value');
    expect(local).toContain('default "local";');
    expect(local).not.toContain('default "remote";');
    expect(unfoldSymbol(source, 'Envelope.java', 'Envelope.Remote.value')).toContain('default "remote";');
    expect(unfoldSymbol(source, 'Envelope.java', 'Envelope.value')).toContain('return "method";');
  }, 120000);

  test('keeps nested ordinary types and methods inside their annotation', () => {
    const source = [
      '@interface Api {',
      '  enum Mode { SAFE }',
      '  class Helper {',
      '    String describe() { return "owned helper"; }',
      '  }',
      '  @interface Detail { String label(); }',
      '  Mode mode() default Mode.SAFE;',
      '}',
    ].join('\n');
    const api = parseFile(source, 'Api.java').symbols[0];
    expect(api?.name).toBe('Api');
    expect(api?.children?.map(symbol => [symbol.name, symbol.kind])).toEqual([
      ['Mode', 'enum'], ['Helper', 'class'], ['Detail', 'interface'], ['mode', 'method'],
    ]);
    expect(unfoldSymbol(source, 'Api.java', 'Api.Helper.describe')).toContain('owned helper');
    expect(unfoldSymbol(source, 'Api.java', 'Api.Detail.label')).toContain('String label();');
  }, 120000);

  test('retains multiline defaults and native columns after Unicode text', () => {
    const source = [
      '/* 配置 😀 */ public @interface Labels {',
      '  /** Ordered labels. */',
      '  String[] value() default {',
      '    "alpha  beta",',
      '    "路由"',
      '  };',
      '  String next();',
      '}',
    ].join('\n');
    const labels = parseFile(source, 'Labels.java').symbols[0];
    expect(labels?.signature).toBe('public @interface Labels');
    expect(labels?.children?.[0].signature).toBe('String[] value() default { "alpha  beta", "路由" };');
    expect(labels?.children?.[0].jsdoc).toContain('Ordered labels');
    const unfolded = unfoldSymbol(source, 'Labels.java', 'Labels.value');
    expect(unfolded).toContain('"alpha  beta",\n    "路由"\n  };');
    expect(unfolded).not.toContain('String next();');
  }, 120000);

  test('returns independently unfoldable annotation elements through native batched search', async () => {
    const sources = {
      'Headers.java': 'class Headers {\n  @interface Route {\n    String value() default "route";\n  }\n}',
      'Metric.java': '@interface Metric {\n  String value() default "metric";\n}',
    };
    const directory = mkdtempSync(join(tmpdir(), 'owned-java-annotations-'));
    try {
      for (const [name, source] of Object.entries(sources)) writeFileSync(join(directory, name), source);
      const result = await searchCodebase(directory, 'value');
      expect(result.matchingSymbols.map(symbol => symbol.symbolName).sort()).toEqual(['Headers.Route.value', 'Metric.value']);
      for (const symbol of result.matchingSymbols) {
        const source = sources[symbol.filePath as keyof typeof sources];
        expect(source).toBeDefined();
        const unfolded = unfoldSymbol(source, symbol.filePath, symbol.symbolName);
        expect(unfolded).toContain(symbol.symbolName === 'Metric.value' ? 'default "metric";' : 'default "route";');
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 120000);

  test('does not mistake annotation uses for new declarations or elements', () => {
    const source = '@Owned(value = "type")\nclass Consumer {\n  @Owned(value = "method")\n  void run() {}\n}';
    const symbols = parseFile(source, 'Consumer.java').symbols;
    expect(symbols.map(symbol => symbol.name)).toEqual(['Consumer']);
    expect(symbols[0].children?.map(symbol => symbol.name)).toEqual(['run']);
    expect(unfoldSymbol(source, 'Consumer.java', 'Consumer.run')).toContain('void run() {}');
  }, 120000);

  test('keeps ordinary interfaces, classes, records and constructors unchanged', () => {
    const source = 'interface Plain { void run(); }\nclass Impl { Impl() {} void run() {} }\nrecord Point(int x) {}';
    const symbols = parseFile(source, 'Plain.java').symbols;
    expect(symbols.map(symbol => [symbol.name, symbol.kind])).toEqual([
      ['Plain', 'interface'], ['Impl', 'class'], ['Point', 'class'],
    ]);
    expect(symbols[0].children?.map(symbol => symbol.name)).toEqual(['run']);
    expect(symbols[1].children?.map(symbol => symbol.name)).toEqual(['Impl()', 'run']);
  }, 120000);
});
