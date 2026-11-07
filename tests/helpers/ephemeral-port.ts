import type { Server } from '../../src/services/server/Server.js';

/**
 * Binds `server` to port 0 so the OS reserves a free port atomically, and
 * returns the port it picked.
 *
 * Picking a random port in a fixed range and then binding it can collide with
 * another test file or with the runner's own outbound sockets (40000–49999 sits
 * inside Linux's ephemeral range), and the resulting EADDRINUSE fails
 * unrelated assertions.
 */
export async function listenOnEphemeralPort(server: Server, host = '127.0.0.1'): Promise<number> {
  await server.listen(0, host);
  const address = server.getHttpServer()?.address();
  if (!address || typeof address === 'string') {
    throw new Error(`Expected a TCP listener on ${host}, got ${JSON.stringify(address)}`);
  }
  return address.port;
}
