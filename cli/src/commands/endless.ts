/**
 * endless command — run stream in a persistent reconnecting loop.
 * cmem endless [options]
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON } from '../output.js';
import { CLIError, ExitCode } from '../errors.js';

interface EndlessOpts {
  retryMs?: string;
  json?: boolean;
}

const DEFAULT_RETRY_MS = 3000;
const MAX_RETRY_MS = 30000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function registerEndlessCommand(program: Command): void {
  program
    .command('endless')
    .description('Watch the live stream, auto-reconnecting on disconnect')
    .option('--retry-ms <ms>', 'milliseconds between reconnection attempts', String(DEFAULT_RETRY_MS))
    .option('--json', 'output SSE events as newline-delimited JSON')
    .action(async (opts: EndlessOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      const retryMs = Math.min(
        opts.retryMs ? parseInt(opts.retryMs, 10) : DEFAULT_RETRY_MS,
        MAX_RETRY_MS,
      );

      const config = loadConfig();
      const client = createMemoryClient(config);

      const controller = new AbortController();
      process.on('SIGINT', () => controller.abort());

      if (mode === 'human') {
        process.stdout.write(`Watching stream at ${config.baseUrl} (Ctrl-C to quit)\n\n`);
      }

      while (!controller.signal.aborted) {
        try {
          const res = await client.connectStream();
          const reader = res.body?.getReader();
          if (!reader) {
            throw new CLIError('No response body from stream endpoint', ExitCode.CONNECTION_ERROR);
          }

          const decoder = new TextDecoder();
          let buffer = '';

          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const payload = line.slice(6).trim();
                if (!payload || payload === '[DONE]') continue;
                try {
                  const event = JSON.parse(payload) as Record<string, unknown>;
                  if (mode === 'agent') {
                    outputJSON(event);
                  } else {
                    const type = String(event.type ?? 'event');
                    const ts = new Date().toLocaleTimeString('en-US', { hour12: true });
                    process.stdout.write(`[${ts}] ${type}\n`);
                  }
                } catch {
                  // malformed SSE data — skip
                }
              }
            }
          }
        } catch (err) {
          if (controller.signal.aborted) break;
          if (mode === 'human') {
            process.stderr.write(`Stream disconnected. Reconnecting in ${retryMs}ms...\n`);
          }
        }

        if (!controller.signal.aborted) {
          await sleep(retryMs);
        }
      }

      if (mode === 'human') {
        process.stdout.write('\nStream ended.\n');
      }
    });
}
