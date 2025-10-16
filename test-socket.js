#!/usr/bin/env bun
import net from 'net';
import { existsSync } from 'fs';

const socketPath = '/Users/alexnewman/.claude-mem/test-bun.sock';

const server = net.createServer(() => {});

server.listen(socketPath, () => {
  console.log('Server listening');
  console.log('existsSync says:', existsSync(socketPath));
  console.log('Checking with ls...');
});

server.on('error', (err) => {
  console.error('Error:', err);
  process.exit(1);
});
