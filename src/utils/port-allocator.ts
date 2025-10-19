import net from 'net';

/**
 * Port Allocator Utility
 * Finds available ports dynamically for worker service
 */

const PORT_RANGE_START = 37000;
const PORT_RANGE_END = 37999;

/**
 * Check if a port is available
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find an available port in the configured range
 * Returns a port number or null if none available
 */
export async function findAvailablePort(): Promise<number | null> {
  // Try random ports first (faster for sparse allocation)
  for (let i = 0; i < 10; i++) {
    const randomPort = Math.floor(Math.random() * (PORT_RANGE_END - PORT_RANGE_START + 1)) + PORT_RANGE_START;
    if (await isPortAvailable(randomPort)) {
      return randomPort;
    }
  }

  // Fall back to sequential search
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  return null;
}

/**
 * Check if a specific port is available
 */
export async function checkPort(port: number): Promise<boolean> {
  return isPortAvailable(port);
}
