import { describe, expect, it } from 'bun:test';
import { askApiTarget, type ApiProviderId } from '../../../src/services/agent-runner/api-agent.js';

const partial = '{"reviews": [{"groupId": "first", "summary": "Only part of the requested report"}]}';

async function answer(finishReason: string | undefined, content: unknown, provider: ApiProviderId,
  check: (request: Promise<string>) => Promise<void>) {
  let sends = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    sends++;
    const body = await request.json() as { stream: boolean };
    expect(body.stream).toBe(false);
    return Response.json({ choices: [{ finish_reason: finishReason, message: { content } }] });
  } });
  try {
    await check(askApiTarget({ provider, url: server.url.href, apiKey: 'fixture-key', model: 'fixture-model' },
      'Review every requested group and return the complete report.'));
    expect(sends).toBe(1);
  } finally { server.stop(true); }
}

describe('API agent filtered answers', () => {
  for (const provider of ['openrouter', 'openai-compatible'] as const) {
    for (const multipart of [false, true]) {
      it(`refuses filtered ${multipart ? 'multipart' : 'string'} text from ${provider} without another send`, async () => {
        const content = multipart ? [{ type: 'text', text: partial }] : partial;
        // This body is valid JSON, so a JSON parser cannot establish completeness.
        expect(JSON.parse(partial).reviews).toHaveLength(1);
        await answer('content_filter', content, provider, async request => {
          await expect(request).rejects.toThrow(/finish reason: content_filter/);
        });
      });
    }
  }

  it('keeps complete text and multipart answers, and the existing absent-reason compatibility', async () => {
    for (const finishReason of ['stop', undefined]) {
      for (const content of ['complete answer', [{ type: 'text', text: 'complete ' }, { type: 'text', text: 'answer' }]]) {
        await answer(finishReason, content, 'openai-compatible', async request => {
          expect(await request).toBe('complete answer');
        });
      }
    }
  });
});
