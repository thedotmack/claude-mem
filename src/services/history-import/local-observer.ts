import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isLoopbackHostname } from '../../shared/worker-url.js';
import type { ChatObserver } from './replay.js';

interface OllamaModel { name?: string; remote_model?: string; remote_host?: string }
interface ModelInfo { remote_model?: string; remote_host?: string; capabilities?: string[]; model_info?: Record<string, unknown> }

/** Require a locally installed completion model. Ollama's loopback daemon can also proxy cloud models. */
export async function localChatObserver(requestedModel?: string): Promise<ChatObserver> {
  const configured = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  const url = new URL(configured.includes('://') ? configured : 'http://' + configured);
  if (url.hostname.endsWith('.localhost') || !isLoopbackHostname(url.hostname) || !['http:', 'https:'].includes(url.protocol) ||
      url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('Use a loopback OLLAMA_HOST with a locally installed model to replay transcripts.');
  }

  async function request<T>(path: string, body?: unknown): Promise<T> {
    // Connect directly rather than using a Fetch implementation that can proxy loopback requests.
    // Never follow redirects: evidence belongs only to the selected local model.
    return new Promise((resolve, reject) => {
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(new URL(path, url), {
        method: body ? 'POST' : 'GET', agent: false,
        headers: body ? { 'content-type': 'application/json' } : undefined,
      }, res => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('Local Ollama request failed (HTTP ' + res.statusCode + ').'));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        res.on('error', () => reject(new Error('Local Ollama response was interrupted.')));
        res.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 16 * 1024 * 1024) {
            req.destroy();
            reject(new Error('Local Ollama response was too large.'));
          } else chunks.push(chunk);
        });
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); }
          catch { reject(new Error('Local Ollama returned an invalid response.')); }
        });
      });
      req.on('error', () => reject(new Error('Could not reach local Ollama. Start the Ollama app or run `ollama serve`, then check the installed models with `ollama list`.')));
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }

  const catalog = await request<{ models: OllamaModel[] }>('/api/tags');
  const matches = (catalog.models ?? []).filter(m => typeof m.name === 'string' && !m.remote_model && !m.remote_host &&
    !m.name.includes(':cloud') && !m.name.endsWith('-cloud') &&
    (!requestedModel || m.name === requestedModel || m.name === requestedModel + ':latest'));
  for (const candidate of matches) {
    const model = candidate.name!;
    const info = await request<ModelInfo>('/api/show', {model});
    if (info.remote_host || info.remote_model || !info.model_info?.['general.architecture'] ||
      (info.capabilities && !info.capabilities.includes('completion'))) continue;
    return {
      model,
      async observe(system, evidence) {
        const result = await request<{ response: string; done: boolean; done_reason?: string }>('/api/generate', {
          model, system, prompt: evidence, stream: false,
          options: { temperature: 0, num_predict: 2048, num_ctx: 8192 },
        });
        if (!result.done || result.done_reason === 'length' || typeof result.response !== 'string') {
          throw new Error('Local observer output was incomplete. This turn was not saved.');
        }
        return result.response;
      },
    };
  }
  throw new Error('No matching local Ollama chat model is installed. Use `ollama list` and --model NAME, or install a local chat model with `ollama pull NAME` and rerun.');
}
