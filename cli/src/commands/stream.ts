/**
 * stream command — live observation feed via SSE.
 * cmem stream [options]
 *
 * Modes:
 *   --tmux    Open as tmux sidebar pane (calls openSidebar then exits)
 *   --inline  Force inline mode; used internally by the tmux sidebar pane
 *   --json    Output raw SSE events as newline-delimited JSON
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { detectOutputMode, outputError, outputJSON } from '../output.js';
import { CLIError, ExitCode } from '../errors.js';
import { consumeSSE } from '../tmux/sse-consumer.js';
import { renderSSEEvent } from '../tmux/renderer.js';
import { openSidebar } from '../tmux/sidebar.js';

interface StreamOpts {
  tmux?: boolean;
  inline?: boolean;
  json?: boolean;
  width?: string;
}

export function registerStreamCommand(program: Command): void {
  program
    .command('stream')
    .description('Watch live observations as they are saved by the worker')
    .option('--tmux', 'open as a tmux sidebar pane instead of inline')
    .option('--inline', 'force inline output (used by the tmux pane internally)')
    .option('--json', 'output raw SSE events as newline-delimited JSON')
    .option('--width <size>', 'tmux pane width (default: 35%)', '35%')
    .action(async (opts: StreamOpts) => {
      const mode = detectOutputMode({ json: opts.json });

      // --- tmux sidebar mode ---
      if (opts.tmux) {
        try {
          openSidebar({ width: opts.width });
        } catch (err) {
          const cliErr = err instanceof CLIError
            ? err
            : new CLIError((err as Error).message, ExitCode.INTERNAL_ERROR);
          outputError(cliErr, mode);
          process.exit(cliErr.code);
        }
        return;
      }

      // --- inline / direct stream mode ---
      const config = loadConfig();
      const controller = new AbortController();

      // Graceful shutdown on SIGINT (Ctrl-C)
      const handleSigint = () => {
        controller.abort();
      };
      process.on('SIGINT', handleSigint);

      let connected = false;

      try {
        await consumeSSE({
          baseUrl: config.baseUrl,
          signal: controller.signal,

          onConnect: () => {
            connected = true;
            if (mode === 'human') {
              process.stdout.write('Connected to memory worker stream. Waiting for events...\n\n');
            }
          },

          onEvent: (event) => {
            if (opts.json || mode === 'agent') {
              outputJSON(event);
              return;
            }

            const rendered = renderSSEEvent(event);
            if (rendered) {
              process.stdout.write(rendered + '\n');
            }
          },

          onError: (err) => {
            const cliErr = new CLIError(
              `Stream error: ${err.message}`,
              ExitCode.CONNECTION_ERROR,
              connected
                ? 'The worker may have restarted. Re-run "cmem stream" to reconnect.'
                : "Start the worker with 'cmem worker start'",
            );
            outputError(cliErr, mode);
            process.exit(cliErr.code);
          },
        });
      } finally {
        process.off('SIGINT', handleSigint);
      }

      // Stream ended cleanly (server closed)
      if (mode === 'human') {
        process.stdout.write('\nStream closed.\n');
      }
    });
}
