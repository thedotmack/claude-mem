// Upstream tee: the gateway's route (or, for the `none` configuration, the agent itself) sends here; this forwards
// to the upstream and saves each request body (what went upstream, after the gateway's rewrite stages) and the raw
// response stream. Header values are never saved (names only).
//
// --refresh-claude-token: when the upstream answers 401 to a request that carried a claude.ai bearer token, the tee
// reads Claude Code's current access token again (read only, the same lookup as lib/claude-token.sh) and sends the
// request once more with it. Claude Code rotates that token when it refreshes it and revokes the old one mid-run.
// Each retry is logged to <outDir>/retries.tsv (time, request number, first status, retry status); the token itself
// is never written anywhere. Use it only on the Anthropic tee of the `anthropic` model profile.
//
// Usage: bun tee-proxy.ts <port> <upstream> <outDir> [--refresh-claude-token]
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type AccessTokenReader = () => string | null;

/** Claude Code's claude.ai access token from the contributor's own login, read only. */
export function readClaudeAccessToken(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.EMV_CLAUDE_OAUTH_TOKEN) return env.EMV_CLAUDE_OAUTH_TOKEN;
  let json: string | null = null;
  if (process.platform === 'darwin' && env.EMV_REAL_HOME) {
    const read = Bun.spawnSync(['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-a', env.EMV_REAL_USER ?? '', '-w',
      join(env.EMV_REAL_HOME, 'Library', 'Keychains', 'login.keychain-db')]);
    if (read.exitCode === 0) json = read.stdout.toString();
  }
  const credentialsFile = env.EMV_REAL_CLAUDE_DIR ? join(env.EMV_REAL_CLAUDE_DIR, '.credentials.json') : null;
  if (!json && credentialsFile && existsSync(credentialsFile)) json = readFileSync(credentialsFile, 'utf8');
  if (!json) return null;
  try { return (JSON.parse(json) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken ?? null; }
  catch { return null; }
}

export function startTee(options: { port: number; upstream: string; outDir: string; refreshToken?: AccessTokenReader }) {
  const { upstream, outDir, refreshToken } = options;
  mkdirSync(outDir, { recursive: true });
  let counter = 0;
  return Bun.serve({
    hostname: '127.0.0.1',
    port: options.port,
    idleTimeout: 255, // Bun's maximum: a thinking model can be silent for minutes before its first byte
    async fetch(request) {
      // HTTP only, like the gateway's relay: Codex on a ChatGPT sign-in tries a WebSocket to /responses first, and a
      // 426 makes it fall back to HTTP streaming at once (relay.ts). Without it, the `none` configuration (Codex
      // straight to the tee) spent about 100 s per turn reconnecting before falling back.
      if ((request.headers.get('upgrade') ?? '').toLowerCase().includes('websocket')) {
        return new Response('the tee relays HTTP only; use HTTP streaming', { status: 426, headers: { connection: 'close' } });
      }
      const n = String(++counter).padStart(4, '0');
      const url = new URL(request.url);
      const body = new Uint8Array(await request.arrayBuffer());
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.delete('content-length');
      headers.set('accept-encoding', 'identity');
      writeFileSync(join(outDir, `${n}-req.json`), JSON.stringify({
        time: new Date().toISOString(), method: request.method, path: url.pathname + url.search,
        headerNames: [...request.headers.keys()], bodyBytes: body.length,
      }, null, 1));
      // Codex compresses its request bodies (content-encoding: zstd) when it talks to its provider directly, as in
      // the `none` configuration. The bytes go upstream unchanged; the saved copy is decompressed for the extractor.
      if (body.length) {
        const encoding = (request.headers.get('content-encoding') ?? '').toLowerCase();
        writeFileSync(join(outDir, `${n}-req.body`), encoding === 'zstd' ? Bun.zstdDecompressSync(body) : body);
      }
      const send = () => fetch(upstream + url.pathname + url.search, {
        method: request.method, headers, body: body.length ? body : undefined, redirect: 'manual',
      });
      let response = await send();
      if (refreshToken && response.status === 401 && (headers.get('authorization') ?? '').startsWith('Bearer ')) {
        const token = refreshToken();
        const firstStatus = response.status;
        if (token) {
          await response.arrayBuffer().catch(() => undefined);
          headers.set('authorization', `Bearer ${token}`);
          response = await send();
        }
        appendFileSync(join(outDir, 'retries.tsv'), `${new Date().toISOString()}\t${n}\t${firstStatus}\t${token ? response.status : 'no token found'}\n`);
      }
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
      appendFileSync(join(outDir, 'index.tsv'), `${n}\t${request.method}\t${url.pathname}\t${response.status}\t${response.headers.get('content-type')}\n`);
      const responsePath = join(outDir, `${n}-resp.raw`);
      writeFileSync(responsePath, '');
      const reader = response.body?.getReader();
      const stream = new ReadableStream({
        async pull(controller) {
          if (!reader) { controller.close(); return; }
          const { done, value } = await reader.read();
          if (done) { controller.close(); return; }
          appendFileSync(responsePath, value);
          controller.enqueue(value);
        },
        cancel() { reader?.cancel(); },
      });
      return new Response(stream, { status: response.status, headers: responseHeaders });
    },
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh-claude-token');
  const [portText, upstream, outDir] = args.filter(arg => !arg.startsWith('--'));
  if (!portText || !upstream || !outDir) throw new Error('usage: bun tee-proxy.ts <port> <upstream> <outDir> [--refresh-claude-token]');
  startTee({ port: Number(portText), upstream, outDir, refreshToken: refresh ? () => readClaudeAccessToken() : undefined });
  console.log(`tee on 127.0.0.1:${portText} -> ${upstream}, saving to ${outDir}${refresh ? ' (re-reads the claude.ai token on 401)' : ''}`);
}
