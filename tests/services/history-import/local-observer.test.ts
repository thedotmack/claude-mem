import { afterEach, expect, it } from 'bun:test';
import { localChatObserver } from '../../../src/services/history-import/local-observer.js';

const previousHost = process.env.OLLAMA_HOST;
afterEach(() => {
  if (previousHost === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = previousHost;
});

it('refuses a nonlocal host before any evidence or model request', async () => {
  process.env.OLLAMA_HOST = 'https://models.example.com';
  await expect(localChatObserver()).rejects.toThrow('loopback');
});

it('skips cloud and embedding-only aliases, even behind a loopback Ollama daemon', async () => {
  const seen: string[] = [];
  const endpoint = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
    const path = new URL(req.url).pathname;
    seen.push(path);
    if (path === '/api/tags') return Response.json({models:[{name:'cloud-alias'}, {name:'vector'}]});
    if (path === '/api/show') {
      const {model} = await req.json();
      return Response.json(model === 'cloud-alias'
        ? {remote_host:'https://cloud.example.com', model_info:{'general.architecture':'transformer'}}
        : {capabilities:['embedding'],model_info:{'general.architecture':'transformer'}});
    }
    throw new Error('Unexpected generation request');
  }});
  try {
    process.env.OLLAMA_HOST = String(endpoint.url);
    await expect(localChatObserver()).rejects.toThrow('No matching local Ollama chat model');
    expect(seen).toEqual(['/api/tags','/api/show','/api/show']);
  } finally { endpoint.stop(true); }
});

it('does not send model requests through an environment proxy or follow redirects', async () => {
  let forwarded = 0;
  const proxy = Bun.serve({hostname:'127.0.0.1',port:0,fetch(){forwarded++; return Response.json({});}});
  const endpoint = Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return Response.redirect(proxy.url);}});
  const oldProxy = process.env.HTTP_PROXY;
  try {
    process.env.OLLAMA_HOST = String(endpoint.url);
    process.env.HTTP_PROXY = String(proxy.url);
    await expect(localChatObserver()).rejects.toThrow('HTTP 302');
    expect(forwarded).toBe(0);
  } finally {
    if (oldProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = oldProxy;
    endpoint.stop(true); proxy.stop(true);
  }
});
