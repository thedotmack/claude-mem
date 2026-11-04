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
// --pin-provider=<slug> --pin-model=<model> (OpenRouter profile; both or neither): every inference POST goes upstream
// with `provider: {order: [<slug>], allow_fallbacks: false}`, whichever agent sent it, and must name the pinned model.
// Every answer is checked: a response from another provider or model halts this tee (see `halt` below). `session.sh`
// stops the run when it finds the OFF-PIN file. Same flags turn on the 429 retry (RETRY_429_DELAYS_MS).
//
// Usage: bun tee-proxy.ts <port> <upstream> <outDir> [--refresh-claude-token] [--pin-provider=<slug> --pin-model=<model>]
import { readdirSync, appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type AccessTokenReader = () => string | null;

export interface EndpointPin { providerSlug: string; model: string }

// Retry a 429 after these waits, then pass it to the agent and log it. Reason: pinning removes OpenRouter's fallback to
// another provider, and Endless Mode about doubles requests, so a rate limit that used to reroute now reaches the agent.
// The waits total 122 s, which spans two of OpenRouter's one-minute rate-limit windows and stays under the 255 s idle
// timeout of Bun.serve. Every attempt goes in 429s.tsv, so the count can be reported.
const RETRY_429_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
// Waits before asking OpenRouter which provider served a /responses answer, which names none in its stream. Reason: the
// generation record appears some time after the answer: most within 15 s, but on 2026-11-02 two of 11 were still missing
// after these 126 s and present 5 minutes later. So a miss here never stops a run; every id is listed in
// generations-to-verify.tsv and verify-generations.sh settles what is left when the run ends. A wrong provider stops it.
const GENERATION_LOOKUP_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000];

const INFERENCE_PATH_SUFFIXES = ['/v1/messages', '/chat/completions', '/responses', '/responses/compact'];
export const isInferencePath = (pathname: string) => INFERENCE_PATH_SUFFIXES.some(suffix => pathname.endsWith(suffix));

/** `deepinfra/fp8` -> `deepinfra`; OpenRouter names that provider `DeepInfra`. */
const providerKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
export const providerMatchesPin = (provider: string, pin: EndpointPin) => providerKey(provider) === providerKey(pin.providerSlug.split('/')[0]!);

/** The request body with the pin set. Throws when the body is not a JSON object or names another model. */
export function pinRequestBody(body: Uint8Array, pin: EndpointPin): Uint8Array<ArrayBuffer> {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new Error('request body is not JSON, so the provider pin cannot be set'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body is not a JSON object, so the provider pin cannot be set');
  const request = parsed as Record<string, unknown>;
  if (request.model !== pin.model) throw new Error(`request names model ${JSON.stringify(request.model)}, pinned model is ${pin.model}`);
  return new TextEncoder().encode(JSON.stringify({ ...request, provider: { order: [pin.providerSlug], allow_fallbacks: false } }));
}

/** Reads a response as it streams and reports the first sign that it did not come from the pin. */
export class PinVerifier {
  private buffered = '';
  private sawProvider = false;
  private sawModel = false;
  private isStream: boolean | null = null;
  generationId: string | null = null;
  violation: string | null = null;

  constructor(private readonly pin: EndpointPin) {}

  private inspect(event: unknown) {
    if (event === null || typeof event !== 'object') return;
    const top = event as Record<string, unknown>;
    for (const candidate of [top, top.message, top.response]) {
      if (candidate === null || typeof candidate !== 'object') continue;
      const { provider, model, id } = candidate as Record<string, unknown>;
      if (typeof id === 'string' && id.startsWith('gen-')) this.generationId = id;
      // A provider that times out before answering sends `message_start` with model "unknown", then an error event (DeepInfra,
      // 2026-11-04, requests 1289 and 1295). That names no model, so it is not off-pin. The provider below is still checked.
      if (typeof model === 'string' && model !== 'unknown') {
        this.sawModel = true;
        if (model !== this.pin.model) this.violation ??= `served by model ${model}, pinned model is ${this.pin.model}`;
      }
      if (typeof provider === 'string') {
        this.sawProvider = true;
        if (!providerMatchesPin(provider, this.pin)) this.violation ??= `served by provider ${provider}, pinned endpoint is ${this.pin.providerSlug}`;
      }
    }
  }

  private inspectDataLine(line: string) {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try { this.inspect(JSON.parse(data)); } catch { /* a data line that is not JSON names nothing; the agent reports it */ }
  }

  feed(text: string) {
    this.buffered += text;
    this.isStream ??= this.buffered.trimStart() === '' ? null : !this.buffered.trimStart().startsWith('{');
    if (!this.isStream) return;  // A whole-JSON answer is read at the end.
    const lines = this.buffered.split('\n');
    this.buffered = lines.pop() ?? '';
    for (const line of lines) this.inspectDataLine(line);
  }

  finish() {
    if (this.isStream === false) {
      try { this.inspect(JSON.parse(this.buffered)); } catch { /* not JSON: nothing named */ }
    } else this.inspectDataLine(this.buffered);
    this.buffered = '';
  }

  /** An answer that names a model but no provider must be looked up by its generation id (/responses does this). */
  get needsGenerationLookup() { return this.violation === null && this.sawModel && !this.sawProvider; }
}

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

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

export function startTee(options: {
  port: number; upstream: string; outDir: string; refreshToken?: AccessTokenReader; pin?: EndpointPin;
  retry429DelaysMs?: number[]; generationLookupDelaysMs?: number[];
}) {
  const { upstream, outDir, refreshToken, pin } = options;
  const retry429DelaysMs = options.retry429DelaysMs ?? RETRY_429_DELAYS_MS;
  const generationLookupDelaysMs = options.generationLookupDelaysMs ?? GENERATION_LOOKUP_DELAYS_MS;
  mkdirSync(outDir, { recursive: true });
  // Continue after the highest saved request: a continued run (EMV_FIRST_TURN) starts a new tee on the same folder, and
  // restarting at 1 overwrote the earlier turns' saved requests and responses.
  let counter = readdirSync(outDir).reduce((highest, name) => Math.max(highest, Number(/^(\d+)-/.exec(name)?.[1] ?? 0)), 0);
  let haltReason: string | null = null;
  // The first off-pin sign stops this stack: later requests are refused, and session.sh stops at the OFF-PIN file.
  const halt = (n: string, reason: string) => {
    appendFileSync(join(outDir, 'off-pin.tsv'), `${new Date().toISOString()}\t${n}\t${reason}\n`);
    if (haltReason) return;
    haltReason = reason;
    writeFileSync(join(outDir, 'OFF-PIN'), `${n}\t${reason}\n`);
    console.error(`OFF-PIN: request ${n}: ${reason}. This tee now refuses every request.`);
  };
  const refusal = (reason: string) => new Response(JSON.stringify({ type: 'error', error: { type: 'off_pin', message: `tee refused: ${reason}` } }), {
    status: 502, headers: { 'content-type': 'application/json' },
  });
  // Where the generation record lives on OpenRouter, for answers that name no provider.
  const lookUpGeneration = async (n: string, generationId: string, authorization: string | null) => {
    for (const delay of generationLookupDelaysMs) {
      await sleep(delay);
      const answer = await fetch(`${upstream}/v1/generation?id=${encodeURIComponent(generationId)}`, { headers: authorization ? { authorization } : {} }).catch(() => null);
      if (!answer?.ok) continue;
      const provider = (await answer.json() as { data?: { provider_name?: unknown } }).data?.provider_name;
      if (typeof provider !== 'string') continue;
      appendFileSync(join(outDir, 'generation-lookups.tsv'), `${n}\t${generationId}\t${provider}\n`);
      if (!providerMatchesPin(provider, pin!)) halt(n, `served by provider ${provider}, pinned endpoint is ${pin!.providerSlug}`);
      return;
    }
    console.error(`request ${n}: generation ${generationId} not found yet; verify-generations.sh checks it at the end of the run`);
  };
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
      const received = new Uint8Array(await request.arrayBuffer());
      const pinned = pin !== undefined && request.method === 'POST' && isInferencePath(url.pathname);
      if (pinned && haltReason) return refusal(haltReason);
      let body = received;
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.delete('content-length');
      headers.set('accept-encoding', 'identity');
      writeFileSync(join(outDir, `${n}-req.json`), JSON.stringify({
        time: new Date().toISOString(), method: request.method, path: url.pathname + url.search,
        headerNames: [...request.headers.keys()], bodyBytes: body.length,
      }, null, 1));
      // Codex compresses its request bodies (content-encoding: zstd) when it talks to its provider directly, as in
      // the `none` configuration. Without a pin the bytes go upstream unchanged; the saved copy is decompressed for the
      // extractor. With a pin the body is edited, so it goes upstream decompressed and the header is dropped.
      if (body.length) {
        const encoding = (request.headers.get('content-encoding') ?? '').toLowerCase();
        const decoded = encoding === 'zstd' ? Bun.zstdDecompressSync(body) : body;
        if (pinned) {
          try { body = pinRequestBody(decoded, pin); }
          catch (error) {
            const reason = (error as Error).message;
            halt(n, reason);
            return refusal(reason);
          }
          headers.delete('content-encoding');
        }
        writeFileSync(join(outDir, `${n}-req.body`), pinned ? body : decoded);
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
      if (pin) {
        for (let attempt = 0; response.status === 429; attempt++) {
          const wait = retry429DelaysMs[attempt];
          appendFileSync(join(outDir, '429s.tsv'), `${new Date().toISOString()}\t${n}\t${attempt + 1}\t${wait ?? 'gave up: passed to the agent'}\n`);
          if (wait === undefined) { console.error(`request ${n}: still 429 after ${attempt} retries; passing it to the agent`); break; }
          await response.arrayBuffer().catch(() => undefined);
          await sleep(wait);
          response = await send();
        }
      }
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
      appendFileSync(join(outDir, 'index.tsv'), `${n}\t${request.method}\t${url.pathname}\t${response.status}\t${response.headers.get('content-type')}\n`);
      const responsePath = join(outDir, `${n}-resp.raw`);
      writeFileSync(responsePath, '');
      const reader = response.body?.getReader();
      const verifier = pinned && response.status === 200 ? new PinVerifier(pin) : null;
      const decoder = new TextDecoder();
      const authorization = headers.get('authorization');
      const stream = new ReadableStream({
        async pull(controller) {
          if (!reader) { controller.close(); return; }
          const { done, value } = await reader.read();
          if (done) {
            verifier?.finish();
            if (verifier?.violation) { halt(n, verifier.violation); controller.error(new Error(verifier.violation)); return; }
            // Not awaited: the agent should not wait on bookkeeping. A failed lookup still halts later requests.
            if (verifier?.needsGenerationLookup) {
              if (verifier.generationId) {
                appendFileSync(join(outDir, 'generations-to-verify.tsv'), `${n}\t${verifier.generationId}\n`);
                void lookUpGeneration(n, verifier.generationId, authorization);
              } else halt(n, 'the answer names neither a provider nor a generation id');
            }
            controller.close();
            return;
          }
          appendFileSync(responsePath, value);
          if (verifier) {
            verifier.feed(decoder.decode(value, { stream: true }));
            if (verifier.violation) { halt(n, verifier.violation); await reader.cancel(); controller.error(new Error(verifier.violation)); return; }
          }
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
  const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const [providerSlug, pinModel] = [flag('pin-provider'), flag('pin-model')];
  if (Boolean(providerSlug) !== Boolean(pinModel)) throw new Error('--pin-provider and --pin-model go together');
  const [portText, upstream, outDir] = args.filter(arg => !arg.startsWith('--'));
  if (!portText || !upstream || !outDir) throw new Error('usage: bun tee-proxy.ts <port> <upstream> <outDir> [--refresh-claude-token] [--pin-provider=<slug> --pin-model=<model>]');
  const pin = providerSlug && pinModel ? { providerSlug, model: pinModel } : undefined;
  startTee({ port: Number(portText), upstream, outDir, refreshToken: refresh ? () => readClaudeAccessToken() : undefined, pin });
  console.log(`tee on 127.0.0.1:${portText} -> ${upstream}, saving to ${outDir}${refresh ? ' (re-reads the claude.ai token on 401)' : ''}${pin ? ` (pinned to ${pin.providerSlug}, ${pin.model})` : ''}`);
}
