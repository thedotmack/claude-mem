import { describe, expect, test } from 'bun:test';
import { formatFoldedView, parseFile } from '../../../src/services/smart-file-read/parser.js';

describe('smart outline import ranges', () => {
  test('preserves all names and the source of multiline imports on one line', () => {
    const statement = 'import {\n  first,\n  second as renamed\n} from "@example/library";';
    expect(parseFile(statement + '\nfunction use() {}', 'imports.js').imports)
      .toEqual(['import { first, second as renamed } from "@example/library";']);
  }, 120000);
  test('excludes adjacent declarations on the same line', () => {
    const statement = 'import { value } from "@example/library";';
    expect(parseFile(statement + ' const other = 1;', 'imports.js').imports).toEqual([statement]);
  }, 120000);
  test('uses UTF-8 capture columns after a Unicode prefix', () => {
    const statement = 'import { value } from "@example/library";';
    expect(parseFile('const café = 1; ' + statement + ' const after = 2;', 'imports.js').imports).toEqual([statement]);
  }, 120000);
  test('preserves a simple single-line import', () => {
    const statement = 'import value from "@example/library";';
    expect(parseFile(statement + '\nfunction use() {}', 'imports.js').imports).toEqual([statement]);
  }, 120000);
  test('drops carriage returns from CRLF multiline imports', () => {
    const source = 'import {\r\n  first,\r\n  second\r\n} from "./library";\r\nexport function use() {}\r\n';
    expect(parseFile(source, 'imports.ts').imports).toEqual(['import { first, second } from "./library";']);
  }, 120000);

  // Outlines go straight into an agent's context, so each entry stays one line
  // of at most 200 characters, keeping the head and the module source at the end.
  test('caps a long import at 200 characters and keeps both ends', () => {
    const names = Array.from({ length: 40 }, (_, index) => `exportedName${index}`);
    const statement = `import {\n${names.map(name => `  ${name},`).join('\n')}\n} from "@example/library";`;
    const imports = parseFile(statement + '\nfunction use() {}', 'imports.js').imports;
    expect(imports).toHaveLength(1);
    expect(imports[0].length).toBeLessThanOrEqual(200);
    expect(imports[0]).toStartWith('import { exportedName0, exportedName1,');
    expect(imports[0]).toContain(' … ');
    expect(imports[0]).toEndWith('exportedName39, } from "@example/library";');
  }, 120000);
  test('collapses a Go import ( … ) group to one outline line', () => {
    const parsed = parseFile('package main\nimport (\n\t"fmt"\n\t"os"\n)\nfunc main() {}\n', 'main.go');
    expect(parsed.imports).toEqual(['import ( "fmt" "os" )']);
    expect(formatFoldedView(parsed).split('\n')).toContain('    import ( "fmt" "os" )');
  }, 120000);
  test('collapses a multiline Ruby require to one line', () => {
    expect(parseFile('require(\n  "json"\n)\nclass A\nend\n', 'a.rb').imports).toEqual(['require( "json" )']);
  }, 120000);
  test('lists only the Ruby calls that load code as imports', () => {
    const source = [
      'require "yaml"',
      'require_relative "lib/a"',
      'autoload :Parser, "lib/parser"',
      'load "tasks.rb"',
      'class A',
      '  include Comparable',
      '  attr_reader :items',
      '  def x',
      '    items.each do |i|',
      '      puts i',
      '    end',
      '    YAML.load(File.read("a.yml"))',
      '  end',
      'end',
    ].join('\n');
    expect(parseFile(source, 'a.rb').imports)
      .toEqual(['require "yaml"', 'require_relative "lib/a"', 'autoload :Parser, "lib/parser"', 'load "tasks.rb"']);
  }, 120000);
  test('does not list a file-wide RSpec block as an import', () => {
    const examples = Array.from({ length: 30 }, (_, index) =>
      `  it "handles case ${index}" do\n    expect(widget.value).to eq(${index})\n  end`);
    const source = `RSpec.describe Widget do\n${examples.join('\n')}\nend\n`;
    const parsed = parseFile(source, 'widget_spec.rb');
    expect(parsed.imports).toEqual([]);
    expect(formatFoldedView(parsed)).not.toContain('handles case');
  }, 120000);
  test('collapses an SCSS @include block to one line', () => {
    const source = '.button {\n  @include hover {\n    color: blue;\n  }\n}\n';
    expect(parseFile(source, 'styles.scss').imports).toEqual(['@include hover { color: blue; }']);
  }, 120000);
});
