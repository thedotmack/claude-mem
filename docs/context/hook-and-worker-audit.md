HOOK & WORKER SYSTEM AUDIT

  THE FLOW (How Everything Works)

  HOOK LIFECYCLE
  ==============

  1. SessionStart (context-hook.ts + user-message-hook.ts run in parallel)
     └─► ensureWorkerRunning()
     └─► GET /api/context/inject?project=X&mode=Y
     └─► Returns formatted context for Claude's system prompt

  2. UserPromptSubmit (new-hook.ts)
     └─► ensureWorkerRunning()
     └─► POST /api/sessions/init {claudeSessionId, project, prompt, mode}
         └─► createSDKSession() - creates or gets DB session
         └─► setSessionMode() - stores mode in metadata_json
         └─► incrementPromptCounter()
         └─► stripMemoryTagsFromPrompt()
         └─► saveUserPrompt()
         └─► Returns {sessionDbId, promptNumber}
     └─► POST /sessions/:sessionDbId/init {userPrompt, promptNumber}
         └─► initializeSession() - creates ActiveSession in memory
         └─► sdkAgent.startSession() - spawns SDK agent generator

  3. PostToolUse (save-hook.ts)
     └─► ensureWorkerRunning()
     └─► POST /api/sessions/observations {claudeSessionId, tool_name, tool_input, tool_response, cwd}
         └─► Skip check: CLAUDE_MEM_SKIP_TOOLS
         └─► Skip check: session-memory meta-observations
         └─► createSDKSession() - creates/gets DB session
         └─► PrivacyCheckValidator.checkUserPromptPrivacy()
         └─► stripMemoryTagsFromJson()
         └─► queueObservation() → PendingMessageStore.enqueue()
         └─► ensureGeneratorRunning() - auto-starts SDK if not running

  4. Stop (summary-hook.ts)
     └─► ensureWorkerRunning()
     └─► extractLastMessage() from transcript (user + assistant)
     └─► POST /api/sessions/summarize {claudeSessionId, last_user_message, last_assistant_message}
         └─► PrivacyCheckValidator.checkUserPromptPrivacy()
         └─► queueSummarize()
         └─► ensureGeneratorRunning()
     └─► POST /api/processing {isProcessing: false} - stops spinner

  5. SessionEnd (cleanup-hook.ts)
     └─► ensureWorkerRunning()
     └─► POST /api/sessions/complete {claudeSessionId}
         └─► SessionCompletionHandler.completeByClaudeId()


  SDK AGENT LOOP (SDKAgent.ts)
  ============================

  startSession():
    └─► findClaudeExecutable() / getModelId()
    └─► query({ prompt: messageGenerator, options: {...} })
    └─► for await (const message of queryResult)
        └─► if assistant: processSDKResponse()
            └─► parseObservations() / parseSummary()
            └─► storeObservation() / storeSummary()
            └─► chromaSync (async, fire-and-forget)
            └─► markMessagesProcessed()

  createMessageGenerator() - async generator:
    └─► yield buildInitPrompt() or buildContinuationPrompt()
    └─► for await (message of sessionManager.getMessageIterator())
        └─► peekPending() from PendingMessageStore
        └─► markProcessing()
        └─► yield buildObservationPrompt() or buildSummaryPrompt()

  ---
  🚨 FLOW-BREAKING VALIDATION

  1. DUPLICATE SESSION CREATION (SessionRoutes.ts:305, :385)

  // In handleObservationsByClaudeId AND handleSummarizeByClaudeId:
  const sessionDbId = store.createSDKSession(claudeSessionId, '', '');
  Problem: Both endpoints call createSDKSession() with empty project/prompt. If session doesn't exist, creates broken session. The real init happens in /api/sessions/init which is called first, but these don't trust that.

  2. DOUBLE PRIVACY CHECK (save-hook doesn't strip, SessionRoutes does)

  - save-hook.ts:49-67 - Sends raw tool_input/tool_response to worker
  - SessionRoutes.ts:323-341 - Strips memory tags AFTER receiving

  Flow: Hook → Worker → Strip. But if hook crashed after sending to worker before worker processed, privacy tags could leak. Should strip at hook (edge).

  3. TRIPLE ensureGeneratorRunning() CALLS

  // SessionRoutes.ts lines: 183, 204, 360, 415
  this.ensureGeneratorRunning(sessionDbId, 'observation');
  this.ensureGeneratorRunning(sessionDbId, 'summarize');
  Each queue operation ALSO calls ensureGeneratorRunning. But /sessions/:id/init ALSO starts the generator. Racing.

  4. PROMPT NUMBER COUNTER MISMATCH

  // new-hook.ts:34
  const promptNumber = initResult.promptNumber; // From incrementPromptCounter()

  // SessionRoutes.ts:306
  const promptNumber = store.getPromptCounter(sessionDbId); // Gets CURRENT, not incremented
  The /api/sessions/observations endpoint reads the counter but doesn't increment. Relies on /api/sessions/init having been called first. But if a tool fires before init completes...

  ---
  🎭 OVERDONE / UNNECESSARY

  1. worker-wrapper.ts - Whole File

  153 lines to solve a Windows-specific zombie socket problem. On Unix, useless overhead. Just spawns child process to spawn worker.

  2. SessionEventBroadcaster - 96 lines of indirection

  Every method just calls:
  this.sseBroadcaster.broadcast({...});
  this.workerService.broadcastProcessingStatus();
  Could be 5 utility functions, not a class.

  3. BaseRouteHandler - 82 lines of "abstraction"

  protected parseIntParam(...): number | null
  protected validateRequired(...): boolean
  protected badRequest(...): void
  Express already has parseInt(), and res.status(400).json() is one line. This is just ceremony.

  4. PrivacyCheckValidator - 41 lines for ONE function

  A static method that wraps store.getUserPrompt() and returns null if empty. Could be inline:
  const userPrompt = store.getUserPrompt(id, num);
  if (!userPrompt?.trim()) return;

  5. hook-response.ts - buildHookResponse()

  if (hookType === 'SessionStart') { ... }
  if (hookType === 'UserPromptSubmit' || hookType === 'PostToolUse') { ... }
  if (hookType === 'Stop') { ... }
  All three cases return essentially { continue: true, suppressOutput: true }. 72 lines that could be:
  return JSON.stringify({ continue: true, suppressOutput: true });

  6. DUAL QUEUE SYSTEM (PendingMessageStore + in-memory pendingMessages)

  // SessionManager.ts:186-189
  try {
    const messageId = this.getPendingStore().enqueue(...);
  } catch (error) { throw error; }
  session.pendingMessages.push(message); // ALSO keeps in-memory copy
  // SessionManager.ts:457
  session.pendingMessages.push(message); // Another push
  // ...
  session.pendingMessages.shift(); // Then shift
  Maintains TWO parallel queues. The "persistent" one and the "in-memory for backward compatibility" one. Pick one.

  7. Windows Process Kill Overkill (worker-service.ts:328-406)

  150+ lines of orphan process cleanup with PowerShell commands. On Unix, pgrep | xargs kill. On Windows, three different kill methods.

  ---
  🤷 DATA STRUCTURE UNCERTAINTY (Trying Multiple Things)

  1. tool_input - 5 Different Shapes

  // save-hook.ts:53 - sends raw object
  body: JSON.stringify({ tool_input, ... })

  // SessionRoutes.ts:327 - stringifies after checking !== undefined
  cleanedToolInput = JSON.stringify(tool_input)

  // SessionManager.ts:168 - stores whatever comes in
  tool_input: data.tool_input

  // SDKAgent.ts:239 - stringifies again before building prompt
  tool_input: JSON.stringify(message.tool_input)

  // PendingMessageStore.ts:71 - stringifies for DB if truthy
  tool_input ? JSON.stringify(message.tool_input) : null

  2. session ID - 4 Different Names

  - session_id (Claude Code's name)
  - claudeSessionId (our internal name)
  - sessionDbId (integer DB primary key)
  - sdk_session_id (something else entirely?)

  3. Message Type Handling

  // worker-types.ts:27
  type: 'observation' | 'summarize';

  // PendingMessageStore.ts:12
  message_type: 'observation' | 'summarize';

  // SDKAgent.ts:226-266
  if (message.type === 'observation') { ... }
  else if (message.type === 'summarize') { ... }
  // What if neither? Silent no-op.

  4. Error Response Shapes

  // Different files return different error shapes:
  res.status(400).json({ error: message });           // BaseRouteHandler
  res.status(404).json({ error: message });           // BaseRouteHandler  
  res.status(500).json({ error: error.message });     // handleError
  res.status(403).json({ error: 'Forbidden', message: '...' }); // middleware
  res.json({ status: 'skipped', reason: 'private' }); // SessionRoutes (200 OK!)

  ---
  💩 GENERAL NONSENSE

  1. Lying Comments

  // worker-types.ts:17
  pendingMessages: PendingMessage[];  // Deprecated: now using persistent store, kept for compatibility
  But it's actively used everywhere! "Deprecated" but still the primary queue mechanism in many places.

  2. Magic String TEST_BUILD_ID

  // worker-service.ts:126
  const TEST_BUILD_ID = 'TEST-008-wrapper-ipc';
  Hardcoded debug breadcrumb in production code. Returned in every health check.

  3. Useless Fallback with Error Logging

  // save-hook.ts:58-64
  cwd: cwd || logger.happyPathError(
    'HOOK', 'Missing cwd...', undefined, { session_id, tool_name }, ''
  )
  If cwd is missing, logs an error AND uses empty string. The empty string will break downstream. Either require it or provide real default.

  4. getTimeout() Multiplier for Windows

  // hook-constants.ts:20-23
  export function getTimeout(baseTimeout: number): number {
    return process.platform === 'win32'
      ? Math.round(baseTimeout * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER) // 1.5x
      : baseTimeout;
  }
  Only used in 2 places. Just write 5000 and 7500.

  5. Spinner Control via HTTP

  // summary-hook.ts:87-99
  try {
    const spinnerResponse = await fetch(`http://127.0.0.1:${port}/api/processing`, {
      method: 'POST',
      body: JSON.stringify({ isProcessing: false }),
    });
  } catch (error) { /* swallow */ }
  Makes HTTP call to stop spinner even though summary hook just queued work. Worker will broadcast real status anyway.

  6. Dead Code Path

  // cleanup-hook.ts:58-68
  if (stdin.isTTY) {
    cleanupHook(undefined); // Will throw "cleanup-hook requires input"
  }
  This code path crashes immediately. Manual testing mode that doesn't work.

  7. Circular Import Dodge

  // worker-service.ts:300
  const { generateContext } = await import('../context-generator.js');
  Dynamic import to avoid circular dependency. Symptom of tangled architecture.

  8. Log Spam

  // SessionRoutes.ts:47-52
  logger.info('SESSION', `ensureGeneratorRunning called (${source})`, {
    sessionId, sessionExists, hasGenerator, queueDepth
  });
  Called 4 times per observation. That's a LOT of logs.

  ---
  SUMMARY

  The Architecture: Hooks call worker HTTP endpoints. Worker queues messages. SDK agent generator consumes queue. Messages persisted to SQLite for crash recovery.

  The Reality:
  - Dual queue systems (in-memory + SQLite) that fight each other
  - Session creation happens in 3 places with different data
  - Privacy stripping happens too late (worker, not hook)
  - Generator auto-start called excessively
  - Windows-specific code weighs down Unix users
  - "Deprecated" code still primary path
  - Validation that breaks flow scattered randomly