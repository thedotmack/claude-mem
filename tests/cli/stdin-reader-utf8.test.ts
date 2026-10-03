import { describe, expect, it } from 'bun:test';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

async function readSplitPrompt(prompt: string, split: number): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-stdin-utf8-'));
  const modulePath = join(import.meta.dir, '../../src/cli/stdin-reader.ts');
  const source = `import { readJsonFromStdin } from ${JSON.stringify(modulePath)};
    const input = readJsonFromStdin({ safetyTimeoutMs: 1000 });
    process.stdin.once('data', () => console.log('FRAGMENT'));
    console.log('READY');
    console.log(JSON.stringify(await input));`;
  const payload = Buffer.from(JSON.stringify({ prompt }));
  const offset = payload.indexOf(Buffer.from(prompt)) + split;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', source], {
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: root, CLAUDE_CONFIG_DIR: root,
          CLAUDE_MEM_TELEMETRY: '0', DO_NOT_TRACK: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      let stderr = '';
      let sent = false;
      let ended = false;
      const deadline = setTimeout(() => { child.kill(); reject(new Error('Child reader timed out')); }, 3000);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (!sent && output.includes('READY\n')) {
          sent = true;
          child.stdin.write(payload.subarray(0, offset));
        }
        // Wait until the actual reader has received the first fragment. A
        // time delay alone allows both writes to coalesce in a busy child.
        if (!ended && output.includes('FRAGMENT\n')) {
          ended = true;
          child.stdin.end(payload.subarray(offset));
        }
      });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => { clearTimeout(deadline); reject(error); });
      child.on('close', code => {
        clearTimeout(deadline);

        try {
          expect({ code, stderr }).toMatchObject({ code: 0 });
          resolve(JSON.parse(output.trim().split('\n').at(-1)!));
        } catch (error) { reject(error); }
      });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('hook stdin UTF-8 byte boundaries', () => {
  for (const [prompt, boundaries] of [['日本語', [1, 2]], ['😀 hello', [1, 2, 3]]] as const) {
    for (const split of boundaries) {
      it(`preserves ${prompt} split ${split} bytes into its first code point`, async () => {
        expect(await readSplitPrompt(prompt, split)).toEqual({ prompt });
      });
    }
  }

  it('preserves ASCII JSON split across pipe writes', async () => {
    expect(await readSplitPrompt('hello', 2)).toEqual({ prompt: 'hello' });
  });
});
