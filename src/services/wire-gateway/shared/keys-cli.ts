// SPDX-License-Identifier: Apache-2.0
//
// `claude-mem wire keys add|list|remove <name>` (plan Phase 16 task 2). The
// raw client key is printed once, by `add`, to stdout; nothing else ever
// prints it, and `list` never prints a hash or a server API key.

import { formatHostForUrl } from '../../../shared/worker-url.js';
import type { WireGatewayConfig } from '../config.js';
import type { DirectHttpOutcome, DirectHttpRequest } from '../direct-http.js';
import { addWireClientKey, checkServerDestination, listWireClientKeys, removeWireClientKey } from './client-keys.js';

/** Where `keys add` reads the server API key when --server-api-key is not given (an argument shows in `ps`). */
export const SERVER_API_KEY_ENV = 'CLAUDE_MEM_WIRE_SERVER_API_KEY';

export interface WireKeysCliOptions {
  config: Pick<WireGatewayConfig, 'shared' | 'sharedHost' | 'sharedPort' | 'retentionDays'>;
  /** Test seams. */
  keysFilePath?: string;
  send?: (request: DirectHttpRequest) => Promise<DirectHttpOutcome>;
  resolveHost?: (hostname: string) => Promise<string[]>;
  env?: Readonly<Record<string, string | undefined>>;
  writeLine?: (line: string) => void;
  writeError?: (line: string) => void;
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

const USAGE = 'Usage: claude-mem wire keys add <name> --server-url <url> --server-project <id> [--server-api-key <key>] | list | remove <name>';

export async function runWireKeysCli(args: string[], options: WireKeysCliOptions): Promise<number> {
  const writeLine = options.writeLine ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const writeError = options.writeError ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const env = options.env ?? process.env;
  const [action, name] = args;
  try {
    if (action === 'add' && name && !name.startsWith('--')) {
      const serverUrl = flagValue(args, '--server-url');
      const projectId = flagValue(args, '--server-project');
      const apiKey = flagValue(args, '--server-api-key') ?? env[SERVER_API_KEY_ENV];
      if (!serverUrl || !projectId || !apiKey) {
        writeError(`wire keys add needs --server-url, --server-project and a server API key (--server-api-key, or ${SERVER_API_KEY_ENV}).`);
        writeError(USAGE);
        return 1;
      }
      const server = { url: serverUrl, apiKey, projectId };
      // Nothing is saved unless the server runtime takes the key and it is project-scoped.
      await checkServerDestination(server, options.send, options.resolveHost);
      const { rawKey, record } = addWireClientKey({ name, server }, options.keysFilePath);
      writeLine(`Client key "${record.name}" added. It is shown this once; give it to the member over a private channel:`);
      writeLine(`  ${rawKey}`);
      writeLine(`Their agent's base URL: https://<this gateway's address>/k/${rawKey}/r/<route>`);
      if (options.config.shared) {
        writeLine(`  (the team listener is http://${formatHostForUrl(options.config.sharedHost)}:${options.config.sharedPort}; put TLS in front of it, and point the TLS proxy there, never at the loopback listener)`);
      }
      writeLine(`Their memory goes to ${record.server.url}, project ${record.server.projectId}.`);
      if (!options.config.shared) writeLine('Note: CLAUDE_MEM_WIRE_GATEWAY_SHARED is not true, so this gateway has no team listener until it is, with CLAUDE_MEM_WIRE_GATEWAY_SHARED_PORT set (then restart it).');
      return 0;
    }
    if (action === 'list' && args.length === 1) {
      const keys = listWireClientKeys(options.keysFilePath);
      if (keys.length === 0) {
        writeLine('No client keys. Add one: claude-mem wire keys add <name> --server-url <url> --server-project <id>');
        return 0;
      }
      for (const key of keys) writeLine(`${key.name}  created ${key.createdAt}  → ${key.serverUrl} (project ${key.serverProjectId})`);
      return 0;
    }
    if (action === 'remove' && name && args.length === 2) {
      if (!removeWireClientKey(name, options.keysFilePath)) {
        writeError(`No client key named "${name}".`);
        return 1;
      }
      writeLine(`Client key "${name}" removed; a running gateway refuses it within a second. Its events still waiting in the outbox are never sent (its server API key went with it): they move to outbox/${name}/<key id>/rejected/ and are deleted after ${options.config.retentionDays} day(s). A key added later under the same name is a new key; it never receives them.`);
      return 0;
    }
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }
  writeError(USAGE);
  return 1;
}
