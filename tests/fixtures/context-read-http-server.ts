import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { generateContextWithStats } from '../../src/services/context/ContextBuilder.js';

ModeManager.getInstance().loadMode('code');
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ status: 'ok' });
    if (path !== '/context') return new Response('Not found', { status: 404 });
    console.log('CONTEXT_READ_STARTED');
    try {
      const input = { projects: ['app'], includePriorMessage: false, timePlaceholders: true };
      const result = await generateContextWithStats(input, false, { execution: 'worker' });
      const inline = await generateContextWithStats(input, false);
      if (result.text !== inline.text) {
        let at = 0;
        while (result.text[at] === inline.text[at]) at++;
        throw new Error(`Isolated context bytes differ from the inline render at ${at}: ${JSON.stringify(result.text.slice(Math.max(0, at - 80), at + 80))} vs ${JSON.stringify(inline.text.slice(Math.max(0, at - 80), at + 80))}`);
      }
      return new Response(result.text);
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }
  },
});
console.log(`READER_HTTP_PORT=${server.port}`);
