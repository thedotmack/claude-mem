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

interface IngestRequest {
  authorization: string | undefined;
  bytes: number;
  body: { v: number; batch: Array<Record<string, any>> };
}

const calls: Call[] = [];
const ingests: IngestRequest[] = [];
let reply: (call: Call, res: ServerResponse) => void = () => {};
let ingestReply: (request: IngestRequest, res: ServerResponse) => void = () => {};
let baseUrl = "";

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    if (req.url === "/api/hooks/ingest") {
      const request: IngestRequest = {
        authorization: req.headers.authorization,
        bytes: raw.length,
        body: JSON.parse(raw.toString("utf8")),
      };
      ingests.push(request);
      ingestReply(request, res);
      return;
    }
    assert.equal(req.url, "/api/mcp");
    const rpc = JSON.parse(raw.toString("utf8"));
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

function accepted(request: IngestRequest, res: ServerResponse) {
  res.writeHead(202, { "content-type": "application/json" });
  res.end(JSON.stringify({ accepted: request.body.batch.length }));
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  calls.length = 0;
  ingests.length = 0;
  reply = (_call, res) => sseText(res, "### [observation:abc] Prefers <tea>\nProject: p");
  ingestReply = accepted;
});

const scope = { key: "v1:scope-key", namespace: "ns", value: "user-1" };
const scopeProject = `eve-${createHash("sha256").update(scope.key).digest("hex")}`;

function userMessage(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

function turnContext(text: string, { abortSignal = new AbortController().signal, sequence = 1 } = {}) {
  const input = [userMessage(text)];
  return {
    abortSignal,
    memory: { scope, slot: "memory" },
    messages: input,
    operationId: `eve-memory-operation-v1:session-1:${sequence}:turn_${sequence}:turn.started:memory`,
    session: { id: "session-1" },
    turn: { id: `turn_${sequence}`, sequence, input },
  } as never;
}

interface ToolUse {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
}

/** A finished turn the way eve hands it to capture: earlier history, this turn's input, then its steps. */
function completedContext(
  prompt: string,
  toolUses: ToolUse[],
  { sequence = 1, earlier = [] as unknown[], sessionId = "session-1" } = {},
) {
  const input = [userMessage(prompt)];
  const steps = toolUses.flatMap((use) => [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: use.id, toolName: use.name, input: use.input }],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: use.id, toolName: use.name, output: use.output }],
    },
  ]);
  return {
    abortSignal: new AbortController().signal,
    memory: { scope, slot: "memory" },
    messages: [...earlier, ...input, ...steps, { role: "assistant", content: [{ type: "text", text: "Done." }] }],
    operationId: `eve-memory-operation-v1:${sessionId}:${sequence}:turn_${sequence}:turn.completed:memory`,
    session: { id: sessionId },
    turn: { id: `turn_${sequence}`, sequence, input },
  } as never;
}

const toolsContext = { abortSignal: new AbortController().signal, memory: { scope, slot: "memory" } } as never;
const callContext = { abortSignal: new AbortController().signal };

type CallableTools = Record<string, { execute: (input: unknown, ctx: unknown) => Promise<unknown> }>;
async function toolsOf(provider: ReturnType<typeof claudeMem>): Promise<CallableTools> {
  return (await provider.tools!(toolsContext)) as unknown as CallableTools;
}

async function capture(provider: ReturnType<typeof claudeMem>, context: never) {
  await provider.capture!["turn.completed"]!(context);
}

const callNamed = (name: string) => calls.find((call) => call.name === name)!;

function quietly<T>(run: () => T | Promise<T>, sink: unknown[] = []): Promise<T> {
  const error = console.error;
  const warn = console.warn;
  console.error = (...args: unknown[]) => sink.push(args);
  console.warn = (...args: unknown[]) => sink.push(args);
  return Promise.resolve()
    .then(run)
    .finally(() => {
      console.error = error;
      console.warn = warn;
    });
}

// The hosted rules (claude-mem-pro src/lib/hooks/envelope.ts and the ingest route).
const HOSTED_EVENTS = ["session-start", "session-init", "observation", "subagent-stop", "summarize", "session-end"];
function assertHostedEnvelope(envelope: Record<string, any>) {
  assert.deepEqual(Object.keys(envelope).sort(), ["event", "payload", "platform", "project", "session_id", "ts", "v"]);
  assert.equal(envelope.v, 1);
  assert.match(envelope.platform, /^[a-z0-9_-]{1,32}$/);
  assert.ok(HOSTED_EVENTS.includes(envelope.event));
  assert.match(envelope.project, /^[A-Za-z0-9_.-]{1,128}$/);
  assert.ok(envelope.session_id.length >= 1 && envelope.session_id.length <= 256);
  assert.ok(Number.isInteger(envelope.ts) && envelope.ts >= 0);
  const payload = envelope.payload;
  if (envelope.event === "session-init" && payload.prompt !== undefined) assert.ok(payload.prompt.length <= 5_000);
  if (envelope.event === "observation") {
    assert.ok(payload.tool_name.length <= 256);
    assert.ok(payload.tool_use_id.length <= 256);
    assert.ok(JSON.stringify(payload.tool_input ?? null).length <= 40_000);
    assert.ok(JSON.stringify(payload.tool_response ?? null).length <= 40_000);
  }
  if (payload.idempotency_key !== undefined) assert.match(payload.idempotency_key, /^[A-Za-z0-9_.:-]{1,256}$/);
}
function assertHostedRequest(request: IngestRequest) {
  assert.equal(request.body.v, 1);
  assert.ok(request.body.batch.length <= 200);
  assert.ok(request.bytes <= 256 * 1024);
  request.body.batch.forEach(assertHostedEnvelope);
}

const sentEnvelopes = () => ingests.flatMap((request) => request.body.batch);

test("refuses to start without an API key", () => {
  assert.throws(() => claudeMem({ apiKey: undefined }), /CLAUDE_MEM_API_KEY/);
  assert.throws(() => claudeMem({ apiKey: "  " }), /CLAUDE_MEM_API_KEY/);
});

test("a fixed project the ingest endpoint would reject fails at startup while capture is on", () => {
  assert.throws(() => claudeMem({ apiKey: "k", project: "my agent" }), /cannot receive captured turns/);
  assert.doesNotThrow(() => claudeMem({ apiKey: "k", project: "my agent", capture: false }));
});

test("recall searches only the scope's own project by default and wraps results as escaped data", async () => {
  const provider = claudeMem({ apiKey: "secret-key", baseUrl });
  const result = await provider.recall["turn.started"](turnContext("what tea do I like?"));

  assert.deepEqual(calls.map((call) => call.name).sort(), ["dumb_search", "timeline"]);
  for (const call of calls) assert.equal(call.authorization, "Bearer secret-key");
  assert.deepEqual(callNamed("dumb_search").arguments, { query: "what tea do I like?", project: scopeProject });

  const message = result?.messages.find((candidate) => candidate.id === "claude-mem-recall");
  assert.equal(message?.id, "claude-mem-recall");
  assert.match(message!.content, /^<claude_mem_recall>\n/);
  assert.match(message!.content, /Prefers &lt;tea&gt;/);
  assert.doesNotMatch(message!.content, /<tea>/);
});

test("every turn injects the newest memory from timeline under the same message id", async () => {
  let timelineReads = 0;
  reply = (call, res) => {
    if (call.name !== "timeline") return sseText(res, "found");
    timelineReads += 1;
    if (timelineReads === 1) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("down");
      return;
    }
    sseText(res, `Memory timeline: read ${timelineReads} <recent>`);
  };
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const contextOf = (result: Awaited<ReturnType<(typeof provider.recall)["turn.started"]>>) =>
    result!.messages.find((message) => message.id === "claude-mem-session-context")!;

  // A failed first read is loud, and the next turn reads again instead of keeping it.
  const first = await quietly(() => provider.recall["turn.started"](turnContext("hello", { sequence: 0 })));
  assert.match(contextOf(first).content, /^<claude_mem_context unavailable="true">.*HTTP 503\. down/);

  for (const sequence of [1, 2]) {
    calls.length = 0;
    const result = await provider.recall["turn.started"](turnContext("and then?", { sequence }));
    assert.deepEqual(calls.map((call) => call.name).sort(), ["dumb_search", "timeline"]);
    assert.deepEqual(callNamed("timeline").arguments, { project: scopeProject, limit: 50 });
    assert.deepEqual(result!.messages.map((message) => message.id).sort(), [
      "claude-mem-recall",
      "claude-mem-session-context",
    ]);
    const context = contextOf(result);
    assert.match(context.content, /^<claude_mem_context>\n/);
    assert.match(context.content, new RegExp(`Memory timeline: read ${sequence + 1} &lt;recent&gt;`));
  }
});

test("searchAllProjects reads every project for recall and session context; a fixed project still receives saves", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl, project: "my-agent", searchAllProjects: true });
  await provider.recall["turn.started"](turnContext("hello", { sequence: 3 }));
  assert.deepEqual(callNamed("dumb_search").arguments, { query: "hello" });
  assert.deepEqual(callNamed("timeline").arguments, { limit: 50 });

  calls.length = 0;
  const tools = await toolsOf(provider);
  await tools.remember.execute({ text: "Likes green tea", title: "Tea" }, callContext);
  assert.equal(calls[0].name, "save_memory");
  assert.deepEqual(calls[0].arguments, {
    text: "Likes green tea",
    title: "Tea",
    project: "my-agent",
    metadata: { source: "eve", slot: "memory" },
  });
});

test("recall cuts the query to the server's 500-character maximum, keeping the newest text", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  await provider.recall["turn.started"](turnContext(`${"a".repeat(600)}END`));
  const query = callNamed("dumb_search").arguments.query as string;
  assert.equal(query.length, 500);
  assert.ok(query.endsWith("END"));
});

test("a turn with no user text runs no search but still gets session context", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const result = await provider.recall["turn.started"](turnContext("   "));
  assert.deepEqual(calls.map((call) => call.name), ["timeline"]);
  assert.deepEqual(result!.messages.map((message) => message.id), ["claude-mem-session-context"]);
});

// A turn's input as eve 0.84.0 and 1.0.0-rc.9 hand it to memory: the trailing
// user-role run of history (activeTurn), every message tagged with `kind`
// (harness/messages.js createUserMessage). eve places the catalog announcement
// just ahead of the turn's input (harness/current-messages.js
// addAnnouncements; its text is execution/catalog/listing.js renderListing
// for an agent with linear, notion and sentry connections) and appends an
// instructions note after it (harness/step/context.js
// takeUserInstructionMessages). Seeded history ending on a user message
// carries `eve.imported`. The announcement placement was reproduced with
// eve's own harness code.
const EVE_CATALOG_ANNOUNCEMENT = [
  "Your connections have more tools than are loaded here. Before saying you have no tool for a task, look for one with eve__search, which searches your own catalog, not the web. Call them with eve__tool({ name, input }).",
  'Connections, whose tools are named <connection>__<tool>; search one connection\'s tools with "<connection>__":',
  "- linear",
  "- notion",
  "- sentry",
].join("\n");
const HUMAN_TEXT = "Run `uname -a` and `date` in your sandbox, then fetch https://example.com and tell me the page title.";
function eveTurnInput(turnId: string) {
  return [
    { role: "user", kind: "user", content: "an earlier conversation's last question", metadata: { "eve.imported": true } },
    { role: "user", kind: "context.state", content: EVE_CATALOG_ANNOUNCEMENT },
    { role: "user", kind: "user", content: HUMAN_TEXT, metadata: { "eve.turn": turnId } },
    { role: "user", kind: "context.instruction", content: [{ type: "text", text: "Answer in French." }] },
  ];
}

test("recall searches for the person's message only, not eve's catalog announcement or other notes", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const input = eveTurnInput("turn_0");
  await provider.recall["turn.started"]({
    abortSignal: new AbortController().signal,
    memory: { scope, slot: "memory" },
    messages: input,
    operationId: "eve-memory-operation-v1:session-1:0:turn_0:turn.started:memory",
    session: { id: "session-1" },
    turn: { id: "turn_0", sequence: 0, input },
  } as never);
  assert.equal(callNamed("dumb_search").arguments.query, HUMAN_TEXT);
});

test("the recall query never carries private regions or secrets", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  await provider.recall["turn.started"](
    turnContext("deploy notes <private>my diary entry</private> with api_key=abc123secretvalue please"),
  );
  const query = callNamed("dumb_search").arguments.query as string;
  assert.ok(query.includes("deploy notes"), query);
  assert.ok(!query.includes("my diary entry"), query);
  assert.ok(!query.includes("abc123secretvalue"), query);
});

test("capture's prompt is the person's message only, not eve's catalog announcement or other notes", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const input = eveTurnInput("turn_0");
  await capture(provider, {
    abortSignal: new AbortController().signal,
    memory: { scope, slot: "memory" },
    messages: [
      ...input,
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "uname -a && date" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "bash", output: { type: "text", value: "Linux" } }] },
      { role: "assistant", content: "page title: Example Domain" },
    ],
    operationId: "eve-memory-operation-v1:session-1:0:turn_0:turn.completed:memory",
    session: { id: "session-1" },
    turn: { id: "turn_0", sequence: 0, input },
  } as never);
  const init = sentEnvelopes().find((envelope) => envelope.event === "session-init")!;
  assert.equal(init.payload.prompt, HUMAN_TEXT);
  assert.doesNotMatch(JSON.stringify(sentEnvelopes()), /eve__search|<connection>__|Answer in French|earlier conversation/);
  assert.deepEqual(
    sentEnvelopes().filter((envelope) => envelope.event === "observation").map((envelope) => envelope.payload.tool_use_id),
    ["turn_0:call_1"],
  );
});

test("a turn whose input is only eve's notes sends no prompt and runs no search", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const input = eveTurnInput("turn_0").filter((message) => message.content !== HUMAN_TEXT);
  const context = {
    abortSignal: new AbortController().signal,
    memory: { scope, slot: "memory" },
    messages: input,
    operationId: "eve-memory-operation-v1:session-1:0:turn_0:turn.started:memory",
    session: { id: "session-1" },
    turn: { id: "turn_0", sequence: 0, input },
  } as never;
  await provider.recall["turn.started"](context);
  assert.deepEqual(calls.map((call) => call.name), ["timeline"]);
  await capture(provider, context);
  assert.equal(sentEnvelopes().find((envelope) => envelope.event === "session-init")!.payload.prompt, undefined);
});

test("an unreachable memory service tells the model and logs instead of failing the turn", async () => {
  reply = (_call, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("boom");
  };
  const logged: unknown[] = [];
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const result = await quietly(() => provider.recall["turn.started"](turnContext("hi", { sequence: 0 })), logged);
  assert.equal(result!.messages.length, 2);
  for (const message of result!.messages) assert.match(message.content, /unavailable="true".*HTTP 500\. boom/);
  assert.equal(logged.length, 2);
});

test("an HTML error page is described, not pasted into the model's context", async () => {
  reply = (_call, res) => {
    res.writeHead(502, { "content-type": "text/html" });
    res.end("<html>bad gateway</html>");
  };
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const result = await quietly(() => provider.recall["turn.started"](turnContext("hi")));
  const content = result!.messages.find((message) => message.id === "claude-mem-recall")!.content;
  assert.match(content, /HTTP 502\. \(text\/html body, 24 characters\)/);
  assert.doesNotMatch(content, /bad gateway/);
});

test("a cancelled turn propagates instead of reporting memory as unavailable", async () => {
  const controller = new AbortController();
  reply = () => controller.abort();
  const provider = claudeMem({ apiKey: "k", baseUrl });
  await assert.rejects(
    Promise.resolve(provider.recall["turn.started"](turnContext("hi", { abortSignal: controller.signal }))),
  );
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

test("search, timeline and get_observations call the hosted three-layer tools, bound to the scope", async () => {
  reply = (_call, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "found" }] } }));
  };
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const tools = await toolsOf(provider);
  assert.deepEqual(Object.keys(tools).sort(), ["get_observations", "remember", "search", "timeline"]);
  const id = `observation:${"a".repeat(43)}`;

  assert.deepEqual(await tools.search.execute({ query: "tea", limit: 5 }, callContext), { results: "found" });
  await tools.timeline.execute({ anchorId: id, depthBefore: 2, depthAfter: 4 }, callContext);
  await tools.get_observations.execute({ ids: [id] }, callContext);
  assert.deepEqual(calls, [
    { authorization: "Bearer k", name: "memory_search", arguments: { query: "tea", limit: 5, project: scopeProject } },
    {
      authorization: "Bearer k",
      name: "timeline",
      arguments: { anchorId: id, depthBefore: 2, depthAfter: 4, project: scopeProject },
    },
    { authorization: "Bearer k", name: "get_observations", arguments: { ids: [id] } },
  ]);
});

test("tool schemas carry the hosted limits", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const tools = (await provider.tools!(toolsContext)) as unknown as Record<
    string,
    { inputSchema: { safeParse: (value: unknown) => { success: boolean } } }
  >;
  const id = `observation:${"a".repeat(43)}`;
  assert.equal(tools.search.inputSchema.safeParse({ query: "x", limit: 50 }).success, true);
  assert.equal(tools.search.inputSchema.safeParse({ query: "x", limit: 51 }).success, false);
  assert.equal(tools.timeline.inputSchema.safeParse({ anchorId: id, depthBefore: 20 }).success, true);
  assert.equal(tools.timeline.inputSchema.safeParse({ depthAfter: 21 }).success, false);
  assert.equal(tools.timeline.inputSchema.safeParse({ anchorId: "observation:short" }).success, false);
  assert.equal(tools.get_observations.inputSchema.safeParse({ ids: Array(100).fill(id) }).success, true);
  assert.equal(tools.get_observations.inputSchema.safeParse({ ids: Array(101).fill(id) }).success, false);
  assert.equal(tools.get_observations.inputSchema.safeParse({ ids: [] }).success, false);
  assert.equal(tools.get_observations.inputSchema.safeParse({ ids: [`summary:${"a".repeat(43)}`] }).success, false);
});

// ---------- capture ----------

test("capture sends session-init, one observation per tool call, and summarize, all valid for hosted ingest", async () => {
  const provider = claudeMem({ apiKey: "secret-key", baseUrl });
  const context = completedContext("fix the build", [
    { id: "call_1", name: "bash", input: { command: "npm test" }, output: { type: "text", value: "2 passed" } },
    {
      id: "call_2",
      name: "read_file",
      input: { path: "a.ts" },
      output: { type: "json", value: { lines: 3 } },
    },
    { id: "call_3", name: "bash", input: { command: "false" }, output: { type: "error-text", value: "exit 1" } },
  ]);
  await capture(provider, context);

  assert.equal(ingests.length, 1);
  assert.equal(ingests[0].authorization, "Bearer secret-key");
  assertHostedRequest(ingests[0]);
  const batch = ingests[0].body.batch;
  assert.deepEqual(batch.map((envelope) => envelope.event), [
    "session-init",
    "observation",
    "observation",
    "observation",
    "summarize",
  ]);
  for (const envelope of batch) {
    assert.equal(envelope.platform, "eve");
    assert.equal(envelope.project, scopeProject);
    assert.equal(envelope.session_id, "session-1");
  }
  const operationId = "eve-memory-operation-v1:session-1:1:turn_1:turn.completed:memory";
  assert.deepEqual(batch[0].payload, { prompt: "fix the build", idempotency_key: `${operationId}:init` });
  assert.deepEqual(batch[1].payload, {
    tool_use_id: "turn_1:call_1",
    tool_name: "bash",
    // Non-string values are sent as their redacted JSON text, as the Cowork client does.
    tool_input: '{"command":"npm test"}',
    tool_response: "2 passed",
  });
  assert.equal(batch[2].payload.tool_response, '{"lines":3}');
  assert.equal(batch[3].payload.tool_response, '{"error":"exit 1"}');
  assert.deepEqual(batch[4].payload, { idempotency_key: `${operationId}:summarize` });
});

test("capture records only this turn's tool calls, never earlier turns' history", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const earlier = [
    userMessage("first"),
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "old", toolName: "bash", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "old", toolName: "bash", output: { type: "text", value: "x" } }] },
    { role: "assistant", content: "ok" },
  ];
  await capture(
    provider,
    completedContext("second", [{ id: "new", name: "bash", input: {}, output: { type: "text", value: "y" } }], {
      sequence: 2,
      earlier,
    }),
  );
  const observations = sentEnvelopes().filter((envelope) => envelope.event === "observation");
  assert.deepEqual(observations.map((envelope) => envelope.payload.tool_use_id), ["turn_2:new"]);
});

test("an eve note landing mid-turn does not hide the turn's earlier tool calls", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const context = completedContext("second", [{ id: "before", name: "bash", input: {}, output: { type: "text", value: "x" } }], {
    sequence: 2,
    earlier: [userMessage("first"), { role: "assistant", content: "ok" }],
  }) as unknown as { messages: unknown[] };
  const done = context.messages.pop();
  context.messages.push(
    { role: "user", kind: "task.result", content: [{ type: "text", text: "task finished" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "after", toolName: "bash", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "after", toolName: "bash", output: { type: "text", value: "y" } }] },
    done,
  );
  await capture(provider, context as never);
  const observations = sentEnvelopes().filter((envelope) => envelope.event === "observation");
  assert.deepEqual(observations.map((envelope) => envelope.payload.tool_use_id), ["turn_2:before", "turn_2:after"]);
});

test("a turn whose input is only eve's notes never re-sends an earlier turn's tool calls", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const earlier = [
    userMessage("first"),
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "old", toolName: "bash", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "old", toolName: "bash", output: { type: "text", value: "x" } }] },
    { role: "assistant", content: "ok" },
  ];
  const input = [{ role: "user", kind: "task.result", content: [{ type: "text", text: "task finished" }] }];
  await capture(provider, {
    abortSignal: new AbortController().signal,
    memory: { scope, slot: "memory" },
    messages: [
      ...earlier,
      ...input,
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "new", toolName: "bash", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "new", toolName: "bash", output: { type: "text", value: "y" } }] },
      { role: "assistant", content: "Done." },
    ],
    operationId: "eve-memory-operation-v1:session-1:2:turn_2:turn.completed:memory",
    session: { id: "session-1" },
    turn: { id: "turn_2", sequence: 2, input },
  } as never);
  const observations = sentEnvelopes().filter((envelope) => envelope.event === "observation");
  assert.deepEqual(observations.map((envelope) => envelope.payload.tool_use_id), ["turn_2:new"]);
  assert.doesNotMatch(JSON.stringify(sentEnvelopes()), /:old"/);
});

test("a tool call without a result is skipped with a warning", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const context = completedContext("approve it", [
    { id: "done", name: "bash", input: {}, output: { type: "text", value: "ok" } },
  ]) as unknown as { messages: unknown[] };
  context.messages.splice(-1, 0, {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "waiting", toolName: "deploy", input: {} }],
  });
  const logged: unknown[][] = [];
  await quietly(() => capture(provider, context as never), logged);
  const observations = sentEnvelopes().filter((envelope) => envelope.event === "observation");
  assert.deepEqual(observations.map((envelope) => envelope.payload.tool_use_id), ["turn_1:done"]);
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][0]), /tool call not captured: it has no tool result/);
  assert.deepEqual(logged[0][1], { sessionId: "session-1", toolName: "deploy", toolCallId: "waiting" });
});

test("a tool call ID the model reuses in a later turn is still recorded in that turn", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const reused: ToolUse[] = [{ id: "call_0", name: "bash", input: {}, output: { type: "text", value: "x" } }];
  await capture(provider, completedContext("first", reused, { sequence: 1 }));
  await capture(provider, completedContext("second", reused, { sequence: 2 }));
  const ids = sentEnvelopes()
    .filter((envelope) => envelope.event === "observation")
    .map((envelope) => envelope.payload.tool_use_id);
  assert.deepEqual(ids, ["turn_1:call_0", "turn_2:call_0"]);
});

test("a turn and tool call ID pair over 256 characters gets a stable digest tool_use_id", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const uses: ToolUse[] = [{ id: `c${"x".repeat(255)}`, name: "bash", input: {}, output: { type: "text", value: "x" } }];
  await capture(provider, completedContext("long", uses));
  await capture(provider, completedContext("long", uses));
  const ids = ingests.map((request) => request.body.batch[1].payload.tool_use_id);
  assert.match(ids[0], /^eve-tool-sha256:[0-9a-f]{64}$/);
  assert.equal(ids[0], ids[1]);
  ingests.forEach(assertHostedRequest);
});

test("the slot's own memory tools are never captured", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  await capture(
    provider,
    completedContext("what do I like?", [
      { id: "m1", name: "memory__search", input: { query: "likes" }, output: { type: "json", value: { results: "x" } } },
      { id: "m2", name: "memory__remember", input: { text: "tea" }, output: { type: "json", value: { saved: "ok" } } },
      { id: "b1", name: "bash", input: { command: "ls" }, output: { type: "text", value: "a.ts" } },
    ]),
  );
  const toolNames = sentEnvelopes()
    .filter((envelope) => envelope.event === "observation")
    .map((envelope) => envelope.payload.tool_name);
  assert.deepEqual(toolNames, ["bash"]);
});

test("other memory tools (Cowork's never-send list) are never captured", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const output = { type: "text", value: "x" };
  await capture(
    provider,
    completedContext("recall", [
      { id: "c1", name: "claude-mem__search", input: {}, output },
      { id: "c2", name: "mcp__claude-mem__timeline", input: {}, output },
      { id: "c3", name: "mcp__plugin_cmem-pro_memory__search", input: {}, output },
      { id: "c4", name: "cmem__save_memory", input: {}, output },
      { id: "b1", name: "bash", input: {}, output },
    ]),
  );
  const toolNames = sentEnvelopes()
    .filter((envelope) => envelope.event === "observation")
    .map((envelope) => envelope.payload.tool_name);
  assert.deepEqual(toolNames, ["bash"]);
});

test("secrets in prompts, tool inputs and tool results reach ingest redacted; normal text is unchanged", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const stripeKey = `sk_live_${"a1B2".repeat(6)}`;
  const databasePassword = "hunter2-db-pass";
  const bearerToken = "eyZ9aBcDeFgHiJkLmNoPqRsT";
  const apiKeyValue = "zq81-not-a-vendor-shape";
  const envDump = [
    `STRIPE_SECRET=${stripeKey}`,
    `DATABASE_URL=postgres://app:${databasePassword}@db.internal:5432/prod`,
    `curl -H "Authorization: Bearer ${bearerToken}" https://api.example.com`,
    `api_key=${apiKeyValue}`,
  ].join("\n");
  await capture(
    provider,
    completedContext(`deploy with ${stripeKey} please`, [
      {
        id: "env",
        name: "bash",
        input: { command: `psql postgres://app:${databasePassword}@db.internal:5432/prod` },
        output: { type: "text", value: envDump },
      },
      {
        id: "json",
        name: "read_file",
        input: { path: "config.json" },
        output: { type: "json", value: { headers: { authorization: `Bearer ${bearerToken}` }, api_key: apiKeyValue } },
      },
      {
        id: "plain",
        name: "bash",
        input: { command: "npm test" },
        output: { type: "text", value: "2 passed in src/a.ts\nall good" },
      },
    ]),
  );
  assertHostedRequest(ingests[0]);
  const sent = JSON.stringify(ingests[0].body);
  for (const secret of [stripeKey, databasePassword, bearerToken, apiKeyValue]) {
    assert.ok(!sent.includes(secret), `${secret} reached ingest`);
  }
  const [init, env, json, plain] = ingests[0].body.batch;
  assert.equal(init.payload.prompt, "deploy with [cmem-redacted] please");
  assert.equal(env.payload.tool_input, '{"command":"psql postgres://[cmem-redacted]@db.internal:5432/prod"}');
  assert.equal(
    env.payload.tool_response,
    [
      "STRIPE_SECRET=[cmem-redacted]",
      "DATABASE_URL=postgres://[cmem-redacted]@db.internal:5432/prod",
      // Cowork's output exactly: its header pattern takes the space before the marker too.
      'curl -H "Authorization:[cmem-redacted]" https://api.example.com',
      "api_key=[cmem-redacted]",
    ].join("\n"),
  );
  assert.match(json.payload.tool_response, /"authorization":"\[cmem-redacted\]"/);
  assert.match(json.payload.tool_response, /"api_key":"\[cmem-redacted\]"/);
  assert.equal(plain.payload.tool_input, '{"command":"npm test"}');
  assert.equal(plain.payload.tool_response, "2 passed in src/a.ts\nall good");
});

test("a replay with the same operationId sends the same tool_use_id and idempotency_key values", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const uses: ToolUse[] = [{ id: "call_9", name: "bash", input: { command: "ls" }, output: { type: "text", value: "x" } }];
  await capture(provider, completedContext("list files", uses));
  await capture(provider, completedContext("list files", uses));
  assert.equal(ingests.length, 2);
  const identities = ingests.map((request) =>
    request.body.batch.map((envelope) => envelope.payload.idempotency_key ?? envelope.payload.tool_use_id),
  );
  assert.deepEqual(identities[0], identities[1]);
  const operationId = "eve-memory-operation-v1:session-1:1:turn_1:turn.completed:memory";
  assert.deepEqual(identities[0], [`${operationId}:init`, "turn_1:call_9", `${operationId}:summarize`]);
});

test("an operationId outside the hosted key format gets a stable digest key", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const sessionId = `s/${"x".repeat(250)}`;
  await capture(provider, completedContext("hi", [], { sessionId }));
  await capture(provider, completedContext("hi", [], { sessionId }));
  const keys = ingests.map((request) => request.body.batch.map((envelope) => envelope.payload.idempotency_key));
  assert.deepEqual(keys[0], keys[1]);
  assert.match(keys[0][0], /^eve-op-sha256:[0-9a-f]{64}:init$/);
  ingests.forEach(assertHostedRequest);
});

test("outage: a 503 throws once, and a later successful turn sends only its own envelopes", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  ingestReply = (_request, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unavailable" }));
  };
  const logged: unknown[] = [];
  await quietly(
    () =>
      assert.rejects(
        capture(
          provider,
          completedContext("turn during outage", [
            { id: "outage_call", name: "bash", input: {}, output: { type: "text", value: "lost" } },
          ], { sequence: 1 }),
        ),
        /HTTP 503\. \{"error":"unavailable"\}.*not retried: nothing from this turn was recorded/,
      ),
    logged,
  );
  assert.equal(ingests.length, 1, "exactly one attempt, no retry");
  assert.equal(logged.length, 1);

  ingests.length = 0;
  ingestReply = accepted;
  await capture(
    provider,
    completedContext("turn after recovery", [
      { id: "fresh_call", name: "bash", input: {}, output: { type: "text", value: "ok" } },
    ], { sequence: 2 }),
  );
  assert.equal(ingests.length, 1);
  const batch = ingests[0].body.batch;
  assert.deepEqual(batch.map((envelope) => envelope.event), ["session-init", "observation", "summarize"]);
  assert.equal(batch[0].payload.prompt, "turn after recovery");
  assert.equal(batch[1].payload.tool_use_id, "turn_2:fresh_call");
  for (const envelope of batch) {
    assert.doesNotMatch(JSON.stringify(envelope), /outage|:1:turn_1:/);
  }
  // Nothing is sent later on its own either.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ingests.length, 1);
});

test("a field over the server maximum is cut with an explicit marker and logged, never sent mangled", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const logged: unknown[] = [];
  await quietly(
    () =>
      capture(
        provider,
        completedContext("p".repeat(6_000), [
          { id: "big", name: "read_file", input: { path: "x" }, output: { type: "text", value: `"${"z".repeat(50_000)}` } },
        ]),
      ),
    logged,
  );
  assertHostedRequest(ingests[0]);
  const [init, observation] = ingests[0].body.batch;
  assert.equal(init.payload.prompt.length, 5_000);
  assert.match(init.payload.prompt, /\[truncated by claude-mem\/eve: \d+ chars over server max\]$/);
  const response = observation.payload.tool_response as string;
  assert.ok(response.startsWith(`"zzz`));
  assert.match(response, /\[truncated by claude-mem\/eve: \d+ chars over server max\]$/);
  assert.ok(JSON.stringify(response).length <= 40_000);
  assert.equal(logged.length, 2);
});

test("private text in a prompt and in tool fields never reaches ingest, even when a private region crosses the cut", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const privateRegion = (size: number) => `<private>PRIVATE_MARKER ${"s".repeat(size)}</private>`;
  // Each region starts before its field's cut and ends after it, and each field
  // is still over the maximum once the region is gone, so the cut still runs.
  const prompt = `${"p".repeat(4_000)}${privateRegion(3_000)}${"p".repeat(2_000)}`;
  const output = `${"z".repeat(39_000)}${privateRegion(5_000)}${"z".repeat(10_000)}`;
  const input = {
    path: "notes.md",
    note: `kept <system-reminder>REMINDER_MARKER</system-reminder> and &lt;private&gt;ESCAPED_MARKER&lt;/private&gt; ${"i".repeat(45_000)}`,
  };
  const logged: unknown[] = [];
  await quietly(
    () => capture(provider, completedContext(prompt, [{ id: "big", name: "read_file", input, output: { type: "text", value: output } }])),
    logged,
  );
  ingests.forEach(assertHostedRequest);
  const sent = JSON.stringify(ingests.map((request) => request.body));
  assert.doesNotMatch(sent, /PRIVATE_MARKER|REMINDER_MARKER|ESCAPED_MARKER|private>|system-reminder|sss/);
  const [init, observation] = ingests[0].body.batch;
  assert.match(init.payload.prompt, /^p+\n\[truncated by claude-mem\/eve: \d+ chars over server max\]$/);
  assert.match(observation.payload.tool_response, /^z+\n\[truncated by claude-mem\/eve: \d+ chars over server max\]$/);
  assert.match(observation.payload.tool_input, /^\{"path":"notes\.md","note":"kept  and  i+\n\[truncated/);
  assert.equal(logged.length, 3, "all three fields were still cut");
});

test("a prompt that is only private text sends no prompt", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  await capture(provider, completedContext("<private>PRIVATE_MARKER</private>", []));
  assert.equal(sentEnvelopes().find((envelope) => envelope.event === "session-init")!.payload.prompt, undefined);
  assert.doesNotMatch(JSON.stringify(sentEnvelopes()), /PRIVATE_MARKER/);
});

const paidEvents = (request: IngestRequest) =>
  request.body.batch.filter((envelope) => envelope.event !== "session-init").length;

test("a turn larger than one request is split under the body limit, in order, summarize last", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const uses: ToolUse[] = Array.from({ length: 12 }, (_, index) => ({
    id: `call_${index}`,
    name: "read_file",
    input: { path: `f${index}` },
    output: { type: "text", value: "y".repeat(30_000) },
  }));
  await capture(provider, completedContext("read everything", uses));
  assert.ok(ingests.length > 1);
  assert.ok(paidEvents(ingests[0]) < 10, "the body limit, not the paid-event limit, split this turn");
  ingests.forEach(assertHostedRequest);
  const events = sentEnvelopes().map((envelope) => envelope.payload.tool_use_id ?? envelope.event);
  assert.deepEqual(events, ["session-init", ...uses.map((use) => `turn_1:${use.id}`), "summarize"]);
});

test("the largest observation the field checks allow still fits one request body", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  // 3-byte UTF-8 text in both JSON fields and the longest allowed identities.
  const sessionId = "会".repeat(256);
  const uses: ToolUse[] = [
    {
      id: "c".repeat(200),
      name: "名".repeat(256),
      input: "中".repeat(60_000),
      output: { type: "text", value: "文".repeat(60_000) },
    },
  ];
  await quietly(() => capture(provider, completedContext("big", uses, { sessionId })));
  ingests.forEach(assertHostedRequest);
  const observationRequest = ingests.find((request) => request.body.batch.some((e) => e.event === "observation"))!;
  // Near the bound worked out in ingestRequests (245,036 bytes), under 262,144.
  assert.ok(observationRequest.bytes > 240_000 && observationRequest.bytes <= 245_036, `${observationRequest.bytes}`);
});

test("25 tool calls go out as requests of at most 10 paid events each, in order, summarize last", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  const uses: ToolUse[] = Array.from({ length: 25 }, (_, index) => ({
    id: `call_${index}`,
    name: "bash",
    input: { command: `echo ${index}` },
    output: { type: "text", value: String(index) },
  }));
  await capture(provider, completedContext("do 25 things", uses));
  ingests.forEach(assertHostedRequest);
  // The hosted route runs only the first 10 paid events of a request right away.
  for (const request of ingests) assert.ok(paidEvents(request) <= 10, `${paidEvents(request)} paid events`);
  assert.deepEqual(ingests.map(paidEvents), [10, 10, 6]);
  const events = sentEnvelopes().map((envelope) => envelope.payload.tool_use_id ?? envelope.event);
  assert.deepEqual(events, ["session-init", ...uses.map((use) => `turn_1:${use.id}`), "summarize"]);
  assert.equal(ingests.at(-1)!.body.batch.at(-1)!.event, "summarize");
});

test("a later request failing reports what was accepted and what was not, with no retry", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  ingestReply = (request, res) => {
    if (ingests.length === 1) return accepted(request, res);
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unavailable" }));
  };
  const uses: ToolUse[] = Array.from({ length: 25 }, (_, index) => ({
    id: `call_${index}`,
    name: "bash",
    input: {},
    output: { type: "text", value: "x" },
  }));
  const logged: unknown[][] = [];
  await quietly(
    () =>
      assert.rejects(
        capture(provider, completedContext("do 25 things", uses)),
        /HTTP 503\..*not retried: 11 of 27 envelopes were accepted \(requests 1-1 of 3\); 16 are not recorded \(request 2 failed and 1 request\(s\) after it were not sent\)/,
      ),
    logged,
  );
  assert.equal(ingests.length, 2, "the failed request is not retried and the last is not sent");
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][0]), /11 of 27 envelopes were accepted/);
  assert.doesNotMatch(String(logged[0][0]), /this turn is not recorded/);
  assert.deepEqual(
    { ...(logged[0][1] as Record<string, unknown>), error: undefined },
    {
      error: undefined,
      sessionId: "session-1",
      envelopesAccepted: 11,
      envelopesSentNotNewlyStored: 0,
      envelopesNotRecorded: 16,
      requestsAccepted: 1,
      requestsNotSent: 1,
    },
  );
});

test("a 202 that stored fewer envelopes than were sent is logged once, not thrown or retried", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  ingestReply = (request, res) => {
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted: request.body.batch.length - 2 }));
  };
  const logged: unknown[][] = [];
  await quietly(
    () =>
      capture(
        provider,
        completedContext("two tools", [
          { id: "a", name: "bash", input: {}, output: { type: "text", value: "x" } },
          { id: "b", name: "bash", input: {}, output: { type: "text", value: "y" } },
        ]),
      ),
    logged,
  );
  assert.equal(ingests.length, 1, "not retried");
  assert.equal(logged.length, 1);
  assert.equal(
    logged[0][0],
    "[claude-mem/eve] capture stored 2 of 4 envelopes sent, not retried; the other 2 were already recorded by an earlier send of this turn, or dropped by the server",
  );
  assert.deepEqual(logged[0][1], { sessionId: "session-1", request: "1 of 1", envelopesSent: 4, envelopesAccepted: 2 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ingests.length, 1, "nothing is sent later on its own");
});

test("a 202 whose body has no accepted count is logged as unconfirmed", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  ingestReply = (_request, res) => {
    res.writeHead(202, { "content-type": "application/json" });
    res.end("{}");
  };
  const logged: unknown[][] = [];
  await quietly(() => capture(provider, completedContext("hi", [])), logged);
  assert.equal(ingests.length, 1);
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][0]), /no accepted count; cannot confirm what was stored, not retried/);
  assert.deepEqual(logged[0][1], { sessionId: "session-1", request: "1 of 1", envelopesSent: 2, envelopesAccepted: null });
});

test("a later failure reports the server's accepted counts, not the envelopes sent", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl });
  ingestReply = (request, res) => {
    if (ingests.length === 1) {
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: request.body.batch.length - 3 }));
      return;
    }
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unavailable" }));
  };
  const uses: ToolUse[] = Array.from({ length: 25 }, (_, index) => ({
    id: `call_${index}`,
    name: "bash",
    input: {},
    output: { type: "text", value: "x" },
  }));
  const logged: unknown[][] = [];
  await quietly(
    () =>
      assert.rejects(
        capture(provider, completedContext("do 25 things", uses)),
        /not retried: 8 of 27 envelopes were accepted \(requests 1-1 of 3\); 16 are not recorded \(request 2 failed and 1 request\(s\) after it were not sent\); 3 sent in the accepted requests were not newly stored \(already recorded by an earlier send of this turn, or dropped by the server\)/,
      ),
    logged,
  );
  assert.equal(ingests.length, 2);
  // One warning for the short first reply, one error for the failure.
  assert.equal(logged.length, 2);
  assert.match(String(logged[0][0]), /capture stored 8 of 11 envelopes sent/);
  assert.deepEqual(
    { ...(logged[1][1] as Record<string, unknown>), error: undefined },
    {
      error: undefined,
      sessionId: "session-1",
      envelopesAccepted: 8,
      envelopesSentNotNewlyStored: 3,
      envelopesNotRecorded: 16,
      requestsAccepted: 1,
      requestsNotSent: 1,
    },
  );
});

test("with capture: false there is no capture handler and nothing reaches ingest", async () => {
  const provider = claudeMem({ apiKey: "k", baseUrl, capture: false });
  assert.equal(provider.capture, undefined);
  await provider.recall["turn.started"](turnContext("hi", { sequence: 0 }));
  const tools = await toolsOf(provider);
  await tools.remember.execute({ text: "x" }, callContext);
  assert.equal(ingests.length, 0);
});
