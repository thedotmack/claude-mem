import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';

// Real cwd that passes isValidCwd (repo root at test runtime).
const CWD = process.cwd();

const basePost = () => ({
  conversationId: 'conv-abc-123',
  artifactDirectoryPath: '/some/brain',
  error: '',
  stepIdx: 7,
  toolCall: {
    name: 'run_command',
    args: { CommandLine: 'echo hi', Cwd: CWD },
  },
  transcriptPath: '/some/transcript.jsonl',
  workspacePaths: [CWD],
});

describe('antigravityCliAdapter.normalizeInput - real agy 1.0.9 payload', () => {
  it('maps conversationId -> sessionId', async () => {
    const { antigravityCliAdapter } = await import('../src/cli/adapters/antigravity-cli.js');
    const r = antigravityCliAdapter.normalizeInput(basePost());
    expect(r.sessionId).toBe('conv-abc-123');
  });

  it('maps workspacePaths[0] -> cwd', async () => {
    const { antigravityCliAdapter } = await import('../src/cli/adapters/antigravity-cli.js');
    const r = antigravityCliAdapter.normalizeInput(basePost());
    expect(r.cwd).toBe(CWD);
  });

  it('falls back to toolCall.args.Cwd when workspacePaths missing', async () => {
    const { antigravityCliAdapter } = await import('../src/cli/adapters/antigravity-cli.js');
    const payload = basePost();
    delete (payload as { workspacePaths?: unknown }).workspacePaths;
    const r = antigravityCliAdapter.normalizeInput(payload);
    expect(r.cwd).toBe(CWD);
  });

  it('maps toolCall.name -> toolName and toolCall.args -> toolInput', async () => {
    const { antigravityCliAdapter } = await import('../src/cli/adapters/antigravity-cli.js');
    const r = antigravityCliAdapter.normalizeInput(basePost());
    expect(r.toolName).toBe('run_command');
    expect((r.toolInput as { CommandLine?: string }).CommandLine).toBe('echo hi');
  });

  it('PostToolUse (has error field) -> toolResponse carries error', async () => {
    const { antigravityCliAdapter } = await import('../src/cli/adapters/antigravity-cli.js');
    const r = antigravityCliAdapter.normalizeInput(basePost());
    expect(r.toolResponse).toEqual({ error: '' });
  });

  it('PreToolUse (no error field) -> toolResponse marks pre-execution', async () => {
    const { antigravityCliAdapter } = await import('../src/cli/adapters/antigravity-cli.js');
    const payload = basePost();
    delete (payload as { error?: unknown }).error;
    const r = antigravityCliAdapter.normalizeInput(payload);
    expect(r.toolResponse).toEqual({ _preExecution: true });
  });

  it('preserves transcriptPath and antigravity metadata', async () => {
    const { antigravityCliAdapter } = await import('../src/cli/adapters/antigravity-cli.js');
    const r = antigravityCliAdapter.normalizeInput(basePost());
    expect(r.transcriptPath).toBe('/some/transcript.jsonl');
    expect(r.metadata?.conversationId).toBe('conv-abc-123');
    expect(r.metadata?.stepIdx).toBe(7);
  });
});

describe('antigravityCliAdapter.formatOutput - allow/deny contract', () => {
  it('defaults to decision allow', async () => {
    const { antigravityCliAdapter } = await import('../src/cli/adapters/antigravity-cli.js');
    expect(antigravityCliAdapter.formatOutput({ continue: true })).toEqual({ decision: 'allow' });
  });

  it('maps block decision to deny and passes reason', async () => {
    const { antigravityCliAdapter } = await import('../src/cli/adapters/antigravity-cli.js');
    const out = antigravityCliAdapter.formatOutput({ decision: 'block', reason: 'nope' }) as {
      decision: string;
      reason?: string;
    };
    expect(out.decision).toBe('deny');
    expect(out.reason).toBe('nope');
  });
});

describe('antigravityCliAdapter - registry wiring', () => {
  it('resolves for both antigravity and antigravity-cli platform ids', async () => {
    const { getPlatformAdapter } = await import('../src/cli/adapters/index.js');
    const { antigravityCliAdapter } = await import('../src/cli/adapters/antigravity-cli.js');
    expect(getPlatformAdapter('antigravity')).toBe(antigravityCliAdapter);
    expect(getPlatformAdapter('antigravity-cli')).toBe(antigravityCliAdapter);
  });
});

describe('AntigravityCliHooksInstaller - event mapping (probe-confirmed)', () => {
  const src = () =>
    readFileSync('src/services/integrations/AntigravityCliHooksInstaller.ts', 'utf-8');

  it('maps only the two tool events confirmed by agy 1.0.9 probing', () => {
    const s = src();
    expect(s).toContain("'PreToolUse': 'observation'");
    expect(s).toContain("'PostToolUse': 'observation'");
  });

  it('does NOT register unverified lifecycle events', () => {
    const s = src();
    // These exist in the Python SDK but the CLI hook runner never fired them.
    // They must stay out of the active map until re-probed (see installer comment).
    expect(s).not.toContain("'SessionStart':");
    expect(s).not.toContain("'Stop':");
    expect(s).not.toContain("'Compaction':");
    expect(s).not.toContain("'Notification':");
    expect(s).not.toContain("'PreInvocation':");
  });

  it('writes hooks to ~/.gemini/config/hooks.json (not settings.json, not antigravity-cli dir)', () => {
    const s = src();
    expect(s).toContain("path.join(GEMINI_CONFIG_DIR, 'config')");
    expect(s).toContain("'hooks.json'");
    expect(s).not.toContain("antigravity-cli', 'hooks.json'");
  });

  it('uses seconds (not ms) for the hook timeout', () => {
    const s = src();
    expect(s).toContain('HOOK_TIMEOUT_SEC = 10');
  });

  it('dispatches via the antigravity-cli platform', () => {
    const s = src();
    expect(s).toContain('hook antigravity-cli');
  });
});
