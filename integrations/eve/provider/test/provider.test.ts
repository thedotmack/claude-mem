import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { claudeMem } from "../src/index.ts";

interface Call {
  authorization: string | undefined;
  name: string;
  arguments: Record<string, unknown>;
}

const calls: Call[] = [];
let reply: (call: Call, res: ServerResponse) => void = () => {};
let baseUrl = "";

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    assert.equal(req.url, "/api/mcp");
    const rpc = JSON.parse(body);
    assert.equal(rpc.method, "tools/call");
    const call: Call = {
      authorization: req.headers.authorization,
      name: rpc.params.name,
      arguments: rpc.params.arguments,
    };
    calls.push(call);
    reply(call, res);
  });
});

function sseText(res: ServerResponse, text: string, isError = false) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], isError } })}\n\n`,
  );
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  calls.length = 0;
  reply = (_call, res) => sseText(res, "### [observation:abc] Prefers <tea>\nProject: p");
});

const scope = { key: "v1:scope-key", namespace: "ns", value: "user-1" };

function turnContext(text: string, abortSignal = new AbortController().signal) {
  return {
    abortSignal,
    memory: { scope, slot: "memory" },
    messages: [],
    operationId: "op-1",
    session: { id: "session-1" },
    turn: { id: "turn-1", sequence: 1, input: [{ role: "user", content: [{ type: "text", text }] }] },
  } as never;
}

const toolsContext = { abortSignal: new AbortController().signal, memory: { scope, slot: "memory" } } as never;
const callContext = { abortSignal: new AbortController().signal };

type CallableTools = Record<string, { execute: (input: unknown, ctx: unknown) => Promise<unknown> }>;
async function toolsOf(provider: ReturnType<typeof claudeMem>): Promise<CallableTools> {
  return (await provider.tools!(toolsContext)) as unknown as CallableTools;
}

test("refuses to start without an API key", () => {
  assert.throws(() => claudeMem({ apiKey: undefined }), /CLAUDE_MEM_API_KEY/);
  assert.throws(() => claudeMem({ apiKey: "  " }), /CLAUDE_MEM_API_KEY/);
});

test("has no automatic capture, so a replayed eve operation can never save twice", () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  assert.equal(provider.capture, undefined);
});

test("recall searches only the scope's own project by default and wraps results as escaped data", async () => {
  const provider = claudeMem({ apiKey: "secret-key", baseUrl });
  const result = await provider.recall["turn.started"](turnContext("what tea do I like?"));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, "Bearer secret-key");
  assert.equal(calls[0].name, "dumb_search");
  const expectedProject = `eve-${createHash("sha256").update(scope.key).digest("hex")}`;
  assert.deepEqual(calls[0].arguments, { query: "what tea do I like?", project: expectedProject });

  const message = result?.messages[0];
  assert.equal(message?.id, "claude-mem-recall");
  assert.match(message!.content, /^<claude_mem_recall>\n/);
  assert.match(message!.content, /Prefers &lt;tea&gt;/);
  assert.doesNotMatch(message!.content, /<tea>/);
});

test("searchAllProjects reads every project; a fixed project still receives saves", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl, project: "my-agent", searchAllProjects: true });
  await provider.recall["turn.started"](turnContext("hello"));
  assert.deepEqual(calls[0].arguments, { query: "hello" });

  const tools = await toolsOf(provider);
  await tools.remember.execute({ text: "Likes green tea", title: "Tea" }, callContext);
  assert.equal(calls[1].name, "save_memory");
  assert.deepEqual(calls[1].arguments, {
    text: "Likes green tea",
    title: "Tea",
    project: "my-agent",
    metadata: { source: "eve", slot: "memory" },
  });
});

test("recall cuts the query to the server's 500-character maximum, keeping the newest text", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  await provider.recall["turn.started"](turnContext(`${"a".repeat(600)}END`));
  const query = calls[0].arguments.query as string;
  assert.equal(query.length, 500);
  assert.ok(query.endsWith("END"));
});

test("recall with no user text makes no request", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  assert.equal(await provider.recall["turn.started"](turnContext("   ")), null);
  assert.equal(calls.length, 0);
});

test("an unreachable memory service tells the model and logs instead of failing the turn", async () => {
  reply = (_call, res) => {
    res.writeHead(500);
    res.end("boom");
  };
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const provider = claudeMem({ apiKey: "k", baseUrl });
    const result = await provider.recall["turn.started"](turnContext("hi"));
    assert.match(result!.messages[0].content, /unavailable="true".*HTTP 500/);
    assert.equal(logged.length, 1);
  } finally {
    console.error = original;
  }
});

test("a cancelled turn propagates instead of reporting memory as unavailable", async () => {
  const controller = new AbortController();
  reply = () => controller.abort();
  const provider = claudeMem({ apiKey: "k", baseUrl });
  await assert.rejects(Promise.resolve(provider.recall["turn.started"](turnContext("hi", controller.signal))));
});

test("a read-only key surfaces the server's refusal from remember", async () => {
  reply = (_call, res) => sseText(res, "This connection can read memory but not save to it.", true);
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const tools = await toolsOf(provider);
  await assert.rejects(
    tools.remember.execute({ text: "x" }, callContext),
    /save_memory failed: This connection can read memory but not save to it/,
  );
});

test("search tool is bound to the scope's project and reads plain JSON replies", async () => {
  reply = (_call, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "found" }] } }));
  };
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const tools = await toolsOf(provider);
  assert.deepEqual(await tools.search.execute({ query: "tea" }, callContext), { results: "found" });
  assert.ok(String(calls[0].arguments.project).startsWith("eve-"));
});
