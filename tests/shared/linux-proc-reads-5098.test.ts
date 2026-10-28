import { describe, it, expect } from 'bun:test';
import { createServer, type Server } from 'net';
import { spawn } from 'child_process';
import {
  listListeningOwnerPidsLinux,
  parseProcNetTcpListenInodes,
  readPosixCommandLine,
} from '../../src/shared/port-reclaim.js';
import { captureProcessName } from '../../src/shared/process-identity.js';

// On BusyBox (Alpine) `ps` has no `-p` and `lsof` ignores its filters, so the
// wedged-worker reclaim read no command line and saw every process as the port
// owner. Linux now reads these from /proc (#5098).

const TCP_TABLE = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:9320 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0',
  '   1: 0100007F:9320 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 4243 1 0000000000000000 20 4 30 10 -1',
  '   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5151 1 0000000000000000 100 0 0 10 0',
].join('\n');

describe('parseProcNetTcpListenInodes (#5098)', () => {
  it('returns only LISTEN sockets on the port, matched by its hex', () => {
    expect(parseProcNetTcpListenInodes(TCP_TABLE, 37664)).toEqual(['4242']); // 0x9320
    expect(parseProcNetTcpListenInodes(TCP_TABLE, 8080)).toEqual(['5151']); // 0x1F90
  });

  it('ignores established connections and other ports', () => {
    expect(parseProcNetTcpListenInodes(TCP_TABLE, 50000)).toEqual([]); // 0xC350 is a remote port
    expect(parseProcNetTcpListenInodes(TCP_TABLE, 1)).toEqual([]);
  });

  it('reads tcp6 rows, whose address is 32 hex digits', () => {
    const tcp6 = [
      '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000000000000000000001000000:9320 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7777 1 0000000000000000 100 0 0 10 0',
    ].join('\n');
    expect(parseProcNetTcpListenInodes(tcp6, 37664)).toEqual(['7777']);
  });
});

describe.skipIf(process.platform !== 'linux')('Linux /proc process reads (#5098)', () => {
  it('names this process as the only owner of a port it listens on', async () => {
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      expect(listListeningOwnerPidsLinux(port)).toEqual([process.pid]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('finds no owner for a port nothing listens on', async () => {
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(listListeningOwnerPidsLinux(port)).toEqual([]);
  });

  it('reads a child process command line and name without ps', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await readPosixCommandLine(child.pid!)).toBe('sleep 30');
      expect(captureProcessName(child.pid!)).toBe('sleep');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('returns null for a PID that does not exist', async () => {
    expect(await readPosixCommandLine(2 ** 22 + 7)).toBeNull();
    expect(captureProcessName(2 ** 22 + 7)).toBeNull();
  });
});
