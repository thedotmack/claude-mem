#!/usr/bin/env node
// Filters chroma-mcp stdout to JSON-RPC frames only.
//
// Why this exists: chroma-mcp 0.2.x writes startup banner lines
// ("Successfully initialized Chroma client", "Starting MCP server", ...)
// to stdout BEFORE the first JSON-RPC frame. The MCP SDK's
// StdioClientTransport treats any non-JSON line on stdout as a fatal
// protocol violation and closes the connection.
//
// This wrapper spawns chroma-mcp as a child, line-buffers its stdout,
// forwards lines that look like JSON ('{' or '[' after trim) to OUR
// stdout, and redirects everything else to OUR stderr (prefixed so
// the diagnostics remain visible in worker logs).
//
// Reporter: issue #2197 (zengyuzhi).

import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

const [, , innerCommand, ...innerArgs] = process.argv;
if (!innerCommand) {
  process.stderr.write('chroma-mcp-stdio-filter: missing inner command argv\n');
  process.exit(2);
}

const child = spawn(innerCommand, innerArgs, {
  stdio: ['inherit', 'pipe', 'inherit'],
  env: process.env,
  windowsHide: true,
});

const decoder = new StringDecoder('utf8');
let buf = '';

function flushLine(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    process.stdout.write(line + '\n');
  } else if (trimmed.length) {
    process.stderr.write('[chroma-mcp banner] ' + line + '\n');
  }
}

child.stdout.on('data', (chunk) => {
  buf += decoder.write(chunk);
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    flushLine(line);
  }
});

child.stdout.on('end', () => {
  buf += decoder.end();
});

child.on('error', (err) => {
  process.stderr.write(`chroma-mcp-stdio-filter: spawn error: ${err.message}\n`);
  process.exit(127);
});

// Wait for 'close' (not 'exit') so all buffered stdout has been drained
// before we flush the remaining frame and exit.
child.on('close', (code, signal) => {
  if (buf.length) {
    const trimmed = buf.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) process.stdout.write(buf);
    else if (trimmed.length) process.stderr.write('[chroma-mcp banner] ' + buf);
    buf = '';
  }
  if (signal) {
    const sigNum = osConstants.signals?.[signal] ?? 0;
    process.exit(128 + sigNum);
  }
  process.exit(code ?? 0);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    try { child.kill(sig); } catch { /* child already gone */ }
  });
}
