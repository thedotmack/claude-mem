/**
 * Small promisified process runner used by repo management and the bash tool.
 * Captures stdout+stderr, enforces a timeout, and never throws on a non-zero
 * exit — callers inspect `code`. Output is byte-capped so a runaway command
 * can't blow the model's context window.
 */
import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Max bytes to retain from each of stdout/stderr (default 64 KiB). */
  maxBuffer?: number;
  input?: string;
}

export function runShell(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return run('bash', ['-lc', command], opts);
}

export function run(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const maxBuffer = opts.maxBuffer ?? 64 * 1024;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise<ExecResult>((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const append = (buf: string, chunk: Buffer): string => {
      if (buf.length >= maxBuffer) return buf;
      const next = buf + chunk.toString('utf-8');
      return next.length > maxBuffer ? next.slice(0, maxBuffer) + '\n…[output truncated]' : next;
    };

    child.stdout.on('data', (c: Buffer) => { stdout = append(stdout, c); });
    child.stderr.on('data', (c: Buffer) => { stderr = append(stderr, c); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + `\n[spawn error: ${err.message}]`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (opts.input !== undefined) {
      child.stdin.end(opts.input);
    }
  });
}
