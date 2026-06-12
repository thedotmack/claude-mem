import { describe, expect, it } from 'bun:test';
import {
  getObservationSkipReason,
  isRoutineReadOnlyCommand,
} from '../../src/shared/observation-filter.js';

describe('observation-filter', () => {
  it('skips meta tools without requiring CLAUDE_MEM_SKIP_TOOLS overrides', () => {
    expect(getObservationSkipReason({
      toolName: 'mcp__codegraph__codegraph_explore',
      toolInput: { query: 'ContextBuilder' },
    })).toBe('meta_tool');

    expect(getObservationSkipReason({
      toolName: 'mcp__serena__initial_instructions',
    })).toBe('meta_tool');
  });

  it('skips routine read-only Bash commands before enqueue', () => {
    const commands = [
      'pwd',
      'rg -n "CLAUDE_MEM_SKIP_TOOLS" src tests',
      'sed -n "1,120p" src/services/worker/http/shared.ts',
      'cat package.json',
      'tail -n 120 /home/jura/.claude-mem/logs/claude-mem-2026-06-12.log',
      'git status --short --branch && git log --oneline -5',
      'git branch --show-current',
      'git branch --list "fix/*"',
      'git remote -v',
      'git remote get-url origin',
      'rg -n "Untitled" src | sed -n "1,40p"',
      'sqlite3 /home/jura/.claude-mem/claude-mem.db "select project, count(*) from observations group by project"',
      "curl -fsS 'http://127.0.0.1:37777/api/context/inject?projects=claude-mem' | sed -n '1,120p'",
      "curl -fsS 'http://127.0.0.1:37777/api/observations?project=claude-mem&limit=3' | jq 'keys'",
    ];

    for (const command of commands) {
      expect(getObservationSkipReason({
        toolName: 'Bash',
        toolInput: { command },
        toolResponse: { stdout: 'ok', exitCode: 0 },
      })).toBe('routine_read_only_command');
    }
  });

  it('keeps compound Bash commands observable when any segment is high signal', () => {
    const commands = [
      'pwd && node scripts/analyze.js',
      'git status --short && python important.py',
      'rg -n "needle" src && npm run build',
    ];

    for (const command of commands) {
      expect(getObservationSkipReason({
        toolName: 'Bash',
        toolInput: { command },
        toolResponse: { stdout: 'ok', exitCode: 0 },
      })).toBeNull();
    }
  });

  it('classifies exec_command using the same command filter as Bash', () => {
    expect(getObservationSkipReason({
      toolName: 'functions.exec_command',
      toolInput: { cmd: 'rg -n "needle" src | head -20' },
      toolResponse: { stdout: 'ok', exitCode: 0 },
    })).toBe('routine_read_only_command');

    expect(getObservationSkipReason({
      toolName: 'functions.exec_command',
      toolInput: { cmd: 'npm run build' },
      toolResponse: { stdout: 'ok', exitCode: 0 },
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'exec_command',
      toolInput: 'rg -n "needle" src | head -20',
      toolResponse: { stdout: 'ok', exitCode: 0 },
    })).toBe('routine_read_only_command');
  });

  it('only skips multi_tool_use.parallel when all nested calls are low signal', () => {
    expect(getObservationSkipReason({
      toolName: 'multi_tool_use.parallel',
      toolInput: {
        tool_uses: [
          { recipient_name: 'functions.exec_command', parameters: { cmd: 'pwd' } },
          { recipient_name: 'functions.exec_command', parameters: { cmd: 'rg -n "needle" src' } },
          { recipient_name: 'mcp__codegraph__codegraph_search', parameters: { query: 'Observation' } },
        ],
      },
      toolResponse: { stdout: 'ok', exitCode: 0 },
    })).toBe('parallel_routine_read_only');

    expect(getObservationSkipReason({
      toolName: 'multi_tool_use.parallel',
      toolInput: {
        tool_uses: [
          { recipient_name: 'functions.exec_command', parameters: { cmd: 'pwd' } },
          { recipient_name: 'functions.exec_command', parameters: { cmd: 'npm run build' } },
        ],
      },
      toolResponse: { stdout: 'ok', exitCode: 0 },
    })).toBeNull();
  });

  it('keeps multi_tool_use.parallel observable when a nested read-only call fails', () => {
    const toolInput = {
      tool_uses: [
        { recipient_name: 'functions.exec_command', parameters: { cmd: 'pwd' } },
        { recipient_name: 'functions.exec_command', parameters: { cmd: 'rg -n "needle" missing-dir' } },
      ],
    };

    expect(getObservationSkipReason({
      toolName: 'multi_tool_use.parallel',
      toolInput,
      toolResponse: {
        results: [
          { stdout: '/home/jura/projects/claude-mem', exitCode: 0 },
          { stderr: 'missing-dir: No such file or directory', exitCode: 2 },
        ],
      },
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'multi_tool_use.parallel',
      toolInput,
      toolResponse: {
        results: [
          { stdout: '/home/jura/projects/claude-mem', exitCode: 0 },
          { stdout: 'src/file.ts: error text from source code', exitCode: 0 },
        ],
      },
    })).toBe('parallel_routine_read_only');
  });

  it('keeps validation and mutating Bash commands observable', () => {
    const commands = [
      'bun test tests/shared/observation-filter.test.ts',
      'npm run build',
      'npm run typecheck',
      'git diff --check',
      'cubic review -j',
      'git branch -D feature/old',
      'git branch feature/new',
      'git remote add upstream https://github.com/example/repo.git',
      'git remote remove upstream',
      'npm install',
      'git commit -m "fix"',
      'sqlite3 /home/jura/.claude-mem/claude-mem.db "update observations set concepts = [] where id = 1"',
      'echo "hello" > note.txt',
      'rg needle 2>errors.log',
      'echo ok 1>note.txt',
      'echo hi>note.txt',
      'printf x>>file',
      "sed -i 's/a/b/' file.txt",
      "sed -i.bak 's/a/b/' file.txt",
      "sed --in-place=.bak 's/a/b/' file.txt",
      'find . -delete',
      'find . -exec rm {} \\;',
    ];

    for (const command of commands) {
      expect(getObservationSkipReason({
        toolName: 'Bash',
        toolInput: { command },
        toolResponse: { stdout: 'ok', exitCode: 0 },
      })).toBeNull();
    }
  });

  it('keeps failed read-only commands observable', () => {
    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'rg -n "error" src' },
      toolResponse: { stdout: 'src/file.ts: error text from source code', exitCode: 0 },
    })).toBe('routine_read_only_command');

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'sed -n "1,20p" missing.ts' },
      toolResponse: 'Error: no such file or directory',
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'rg -n "needle" missing-dir' },
      toolResponse: { stderr: 'missing-dir: No such file or directory', exitCode: 2 },
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'rg -n "error" src' },
      toolResponse: 'src/file.ts: error text from source code',
    })).toBe('routine_read_only_command');

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'tail -n 240 /tmp/worker.log | rg -n "QUEUE ENQUEUED|ERROR|provider"' },
      toolResponse: '[ERROR] historical worker log line',
    })).toBe('routine_read_only_command');

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'rg -n "needle" missing-dir' },
      toolResponse: 'Process exited with code 2',
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'rg -n "needle" missing-dir' },
      toolResponse: 'Command failed with exit code 1',
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'rg -n "needle" missing-dir' },
      toolResponse: 'Command exited with code 2',
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'rg -n "needle" src' },
      toolResponse: 'bash: rg: command not found',
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'curl -fsS "http://127.0.0.1:37777/api/context/inject?projects=missing"' },
      toolResponse: 'curl: (22) The requested URL returned error: 404\nProcess exited with code 22',
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'rg -n "[" src' },
      toolResponse: 'regex parse error:\n    [',
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'cat missing.ts' },
      toolResponse: 'Failed to open file',
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'curl -fsS "http://127.0.0.1:37777/api/context/inject?projects=missing"' },
      toolResponse: 'curl: (22) The requested URL returned error: 404',
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'curl -fsS "http://127.0.0.1:37777/api/context/inject?projects=claude-mem"' },
      toolResponse: 'curl: (7) Failed to connect to 127.0.0.1 port 37777',
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'jq . broken.json' },
      toolResponse: 'jq: parse error: Invalid numeric literal at line 1, column 2',
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'jq . broken.json' },
      toolResponse: 'parse error: Invalid numeric literal at line 1, column 2',
    })).toBeNull();

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'rg -n "failed to read" src' },
      toolResponse: 'src/file.ts: const message = "failed to read from cache";',
    })).toBe('routine_read_only_command');

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'tail -n 240 /tmp/worker.log | rg -n "Process exited|curl|Failed to open"' },
      toolResponse: '221:[INFO] PR comment mentions `Process exited with code 22`, `curl: (22) ... error: 404`, and `Failed to open file` as examples.',
    })).toBe('routine_read_only_command');
  });

  it('allows redirects to /dev/null without treating them as mutations', () => {
    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: 'rg needle src >/dev/null 2>&1' },
      toolResponse: { stdout: 'ok', exitCode: 0 },
    })).toBe('routine_read_only_command');
  });

  it('does not treat empty search results as command failures', () => {
    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: {
        command: "curl -fsS 'http://127.0.0.1:37777/api/search/observations?query=missing'",
      },
      toolResponse: 'No observations found matching "missing"',
    })).toBe('routine_read_only_command');
  });

  it('keeps mutating local worker curl commands observable', () => {
    const commands = [
      "curl -fsS -X POST 'http://127.0.0.1:37777/api/settings' -d '{}'",
      "curl --request DELETE 'http://localhost:37777/api/logs/clear'",
      "curl -fsS 'http://127.0.0.1:37777/api/logs/clear'",
    ];

    for (const command of commands) {
      expect(getObservationSkipReason({
        toolName: 'Bash',
        toolInput: { command },
        toolResponse: { stdout: 'ok', exitCode: 0 },
      })).toBeNull();
    }

    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: { command: "curl -fsS -X GET 'http://127.0.0.1:37777/api/settings'" },
      toolResponse: { stdout: 'ok', exitCode: 0 },
    })).toBe('routine_read_only_command');
  });

  it('parses JSON-string Bash inputs', () => {
    expect(getObservationSkipReason({
      toolName: 'Bash',
      toolInput: JSON.stringify({ command: 'rg -n "needle" src' }),
      toolResponse: 'ok',
    })).toBe('routine_read_only_command');
  });

  it('classifies helper directly for non-object callers', () => {
    expect(isRoutineReadOnlyCommand('find src -type f | sort | head -20')).toBe(true);
    expect(isRoutineReadOnlyCommand('python scripts/update.py')).toBe(false);
  });
});
