import { describe, it, expect } from 'bun:test';
import net from 'net';

describe('EADDRINUSE detection concept', () => {
  it('net.createServer throws EADDRINUSE when port is taken', async () => {
    // Bind a port
    const server1 = net.createServer();
    await new Promise<void>((resolve) => server1.listen(0, resolve));
    const port = (server1.address() as net.AddressInfo).port;

    // Try to bind same port
    const server2 = net.createServer();
    const error = await new Promise<any>((resolve) => {
      server2.on('error', resolve);
      server2.listen(port);
    });

    expect(error.code).toBe('EADDRINUSE');
    server1.close();
  });
});
