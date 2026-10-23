// The only claude-mem container on the shared ODS network. The worker itself
// sits on a private network with no other members, so other ODS containers
// cannot reach its API. This gateway relays the two things that must cross:
//   - the worker's observer calls to LiteLLM (TCP, port 4000);
//   - the ODS dashboard's health probe (GET /api/health only, port 37777).
import http from 'node:http';
import net from 'node:net';

const LITELLM_HOST = 'litellm';
const LITELLM_PORT = 4000;
const WORKER_HOST = 'claude-mem';
const WORKER_PORT = 37777;
const HEALTH_TIMEOUT_MS = 5000;

net.createServer(client => {
  const upstream = net.connect(LITELLM_PORT, LITELLM_HOST);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.pipe(upstream).pipe(client);
}).listen(LITELLM_PORT, '0.0.0.0');

http.createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/api/health') {
    response.writeHead(404).end();
    return;
  }
  // The worker refuses untrusted DNS names in Host (DNS-rebinding guard); localhost is trusted.
  const probe = http.get({
    host: WORKER_HOST,
    port: WORKER_PORT,
    path: '/api/health',
    headers: { host: `localhost:${WORKER_PORT}` },
    timeout: HEALTH_TIMEOUT_MS,
  }, upstream => {
    response.writeHead(upstream.statusCode ?? 502, { 'content-type': 'application/json' });
    upstream.pipe(response);
  });
  probe.on('timeout', () => probe.destroy(new Error('timeout')));
  probe.on('error', () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
}).listen(WORKER_PORT, '0.0.0.0');
