# Phase 0 Task 2: SDK Worker Comprehensive Logging

## Summary

Added comprehensive logging to `/Users/alexnewman/Scripts/claude-mem/src/sdk/worker.ts` to trace the complete flow of the FINALIZE message from receipt through SDK agent processing to database storage.

## Modified Files

1. `/Users/alexnewman/Scripts/claude-mem/src/sdk/worker.ts` - Added 20+ logging points throughout the worker lifecycle

## Logging Points Added

All logs use the `[claude-mem worker]` prefix for easy searching and are sent to stderr using `console.error()`.

### 1. Worker Initialization (Lines 70-73)
- **Location:** `constructor()`
- **What:** Logs when worker instance is created
- **Data:** sessionDbId, socketPath

### 2. Worker Run Started (Lines 80-83)
- **Location:** `run()` method entry
- **What:** Logs when main run loop begins
- **Data:** sessionDbId, socketPath

### 3. Session Loading (Lines 89-100)
- **Location:** `run()` method after `loadSession()`
- **What:** Logs session load failure or success
- **Data:**
  - Failure: sessionDbId
  - Success: sessionDbId, project, sdkSessionId, userPromptLength

### 4. Socket Server Started (Lines 107-110)
- **Location:** `run()` method after `startSocketServer()`
- **What:** Logs successful socket server initialization
- **Data:** socketPath, sessionDbId

### 5. SDK Agent Starting (Lines 113-116)
- **Location:** `run()` method before `runSDKAgent()`
- **What:** Logs SDK agent invocation
- **Data:** sessionDbId, model

### 6. SDK Agent Completed (Lines 120-123)
- **Location:** `run()` method after `runSDKAgent()` completes
- **What:** Logs completion before marking session as done
- **Data:** sessionDbId, sdkSessionId

### 7. Fatal Error Handler (Lines 129-133)
- **Location:** `run()` method catch block
- **What:** Logs any fatal errors with full stack trace
- **Data:** sessionDbId, error message, stack trace

### 8. Socket Connection Received (Lines 157-160)
- **Location:** `startSocketServer()` - connection handler
- **What:** Logs when a client connects to the Unix socket
- **Data:** sessionDbId, socketPath

### 9. Data Received on Socket (Lines 164-167)
- **Location:** `startSocketServer()` - data handler
- **What:** Logs when data arrives on socket
- **Data:** sessionDbId, chunk size

### 10. Message Parsed from Socket (Lines 178-182)
- **Location:** `startSocketServer()` - message parsing
- **What:** Logs successfully parsed JSON message
- **Data:** sessionDbId, messageType, rawMessage (truncated to 500 chars)

### 11. Invalid Message Error (Lines 185-189)
- **Location:** `startSocketServer()` - JSON parse error
- **What:** Logs when message fails to parse
- **Data:** sessionDbId, error message, rawLine (truncated to 200 chars)

### 12. Socket Connection Error (Lines 196-200)
- **Location:** `startSocketServer()` - socket error handler
- **What:** Logs socket-level errors
- **Data:** sessionDbId, error message, stack trace

### 13. Server Errors (Lines 206-216)
- **Location:** `startSocketServer()` - server error handler
- **What:** Logs server-level errors (EADDRINUSE, etc.)
- **Data:** sessionDbId, socketPath (if EADDRINUSE), error details

### 14. Message Handler Entry (Lines 233-237)
- **Location:** `handleMessage()` method entry
- **What:** Logs when processing any message
- **Data:** sessionDbId, messageType, pendingMessagesCount

### 15. FINALIZE Message Detected (Lines 242-246)
- **Location:** `handleMessage()` - finalize detection
- **What:** Logs when FINALIZE message is received (CRITICAL LOG)
- **Data:** sessionDbId, isFinalized=true, pendingMessagesCount

### 16. Observation Message Queued (Lines 249-254)
- **Location:** `handleMessage()` - observation handling
- **What:** Logs observation message details
- **Data:** sessionDbId, toolName, input/output lengths

### 17. SDK Session Initialized (Lines 292-295)
- **Location:** `runSDKAgent()` - onSystemInitMessage callback
- **What:** Logs when SDK session ID is received
- **Data:** sessionDbId, sdkSessionId

### 18. SDK Agent Response Received (Lines 301-306)
- **Location:** `runSDKAgent()` - onAgentMessage callback
- **What:** Logs every response from SDK agent (CRITICAL LOG)
- **Data:** sessionDbId, sdkSessionId, contentLength, contentPreview (200 chars)

### 19. Initial Prompt Yielded (Lines 322-327)
- **Location:** `createMessageGenerator()` - initial prompt
- **What:** Logs when first prompt is sent to SDK agent
- **Data:** sessionDbId, claudeSessionId, project, promptLength

### 20. FINALIZE Processing in Generator (Lines 349-352)
- **Location:** `createMessageGenerator()` - finalize handling
- **What:** Logs when FINALIZE is processed in async generator (CRITICAL LOG)
- **Data:** sessionDbId, sdkSessionId

### 21. Finalize Prompt Yielded (Lines 357-362)
- **Location:** `createMessageGenerator()` - after building finalize prompt
- **What:** Logs finalize prompt being sent to SDK agent (CRITICAL LOG)
- **Data:** sessionDbId, sdkSessionId, promptLength, promptPreview (300 chars)

### 22. Failed to Load Session for Finalize (Lines 371-373)
- **Location:** `createMessageGenerator()` - error case
- **What:** Logs if session reload fails during finalize
- **Data:** sessionDbId

### 23. Observation Prompt Yielded (Lines 385-389)
- **Location:** `createMessageGenerator()` - observation handling
- **What:** Logs when observation prompt is sent to SDK agent
- **Data:** sessionDbId, toolName, promptLength

### 24. Parsing Agent Message (Lines 406-410)
- **Location:** `handleAgentMessage()` method entry
- **What:** Logs when starting to parse agent response
- **Data:** sessionDbId, sdkSessionId, contentLength

### 25. Observations Parsed (Lines 414-418)
- **Location:** `handleAgentMessage()` - after parseObservations()
- **What:** Logs how many observations were found
- **Data:** sessionDbId, sdkSessionId, observationCount

### 26. Storing Observation (Lines 422-428)
- **Location:** `handleAgentMessage()` - in observation loop
- **What:** Logs each observation being stored
- **Data:** sessionDbId, sdkSessionId, project, observationType, observationTextLength

### 27. Cannot Store Observation (Lines 431-434)
- **Location:** `handleAgentMessage()` - error case
- **What:** Logs when SDK session ID is missing
- **Data:** sessionDbId, observationType

### 28. Attempting to Parse Summary (Lines 439-442)
- **Location:** `handleAgentMessage()` - before parseSummary()
- **What:** Logs when attempting summary parse (CRITICAL LOG)
- **Data:** sessionDbId, sdkSessionId

### 29. Summary Parsed Successfully (Lines 446-456)
- **Location:** `handleAgentMessage()` - after parseSummary() success
- **What:** Logs summary structure details (CRITICAL LOG)
- **Data:** sessionDbId, sdkSessionId, project, hasRequest, hasInvestigated, hasLearned, hasCompleted, filesReadCount, filesEditedCount

### 30. Storing Summary in Database (Lines 470-474)
- **Location:** `handleAgentMessage()` - before storeSummary()
- **What:** Logs summary about to be stored (CRITICAL LOG)
- **Data:** sessionDbId, sdkSessionId, project

### 31. Summary Stored Successfully (Lines 478-482)
- **Location:** `handleAgentMessage()` - after storeSummary()
- **What:** Logs successful database storage (CRITICAL LOG)
- **Data:** sessionDbId, sdkSessionId, project

### 32. Summary Parsed but No SDK Session (Lines 484-486)
- **Location:** `handleAgentMessage()` - error case
- **What:** Logs when summary found but can't store
- **Data:** sessionDbId

### 33. No Summary Found (Lines 488-491)
- **Location:** `handleAgentMessage()` - no summary case
- **What:** Logs when response has no summary
- **Data:** sessionDbId, sdkSessionId

### 34. Cleanup Started (Lines 499-504)
- **Location:** `cleanup()` method entry
- **What:** Logs cleanup process beginning
- **Data:** sessionDbId, socketPath, hasServer, socketExists

### 35. Cleanup Complete (Lines 513-515)
- **Location:** `cleanup()` method exit
- **What:** Logs cleanup finished
- **Data:** sessionDbId

## How to Test

### 1. Start the Worker
```bash
# Start a worker for session ID 1 (for example)
bun run src/sdk/worker.ts 1
```

Look for logs:
- `[claude-mem worker] Worker instance created`
- `[claude-mem worker] Worker run() started`
- `[claude-mem worker] Session loaded successfully`
- `[claude-mem worker] Socket server started successfully`
- `[claude-mem worker] Starting SDK agent`

### 2. Send Messages via Socket
```bash
# From another terminal, send a message to the socket
# Socket path format: /tmp/claude-mem-worker-{sessionDbId}.sock

# Send an observation
echo '{"type":"observation","tool_name":"Read","tool_input":"...","tool_output":"..."}' | nc -U /tmp/claude-mem-worker-1.sock

# Send finalize
echo '{"type":"finalize"}' | nc -U /tmp/claude-mem-worker-1.sock
```

### 3. Monitor Logs
Use grep to filter for specific events:

```bash
# All worker logs
bun run src/sdk/worker.ts 1 2>&1 | grep '\[claude-mem worker\]'

# Only FINALIZE-related logs
bun run src/sdk/worker.ts 1 2>&1 | grep -i finalize

# Only summary-related logs
bun run src/sdk/worker.ts 1 2>&1 | grep -i summary

# Only database storage logs
bun run src/sdk/worker.ts 1 2>&1 | grep -i storing
```

## What to Look for When FINALIZE is Sent

The expected log sequence when a FINALIZE message is sent:

1. **Message Receipt:**
   ```
   [claude-mem worker] Data received on socket
   [claude-mem worker] Message received from socket { messageType: 'finalize', ... }
   ```

2. **Message Handling:**
   ```
   [claude-mem worker] Processing message in handleMessage() { messageType: 'finalize', ... }
   [claude-mem worker] FINALIZE message detected { isFinalized: true, ... }
   ```

3. **Generator Processing:**
   ```
   [claude-mem worker] Processing FINALIZE message in generator
   [claude-mem worker] Yielding finalize prompt to SDK agent { promptLength: ..., promptPreview: ... }
   ```

4. **SDK Agent Response:**
   ```
   [claude-mem worker] SDK agent response received { contentLength: ..., contentPreview: ... }
   ```

5. **Parsing and Storage:**
   ```
   [claude-mem worker] Parsing agent message for observations and summary
   [claude-mem worker] Observations parsed from response { observationCount: ... }
   [claude-mem worker] Attempting to parse summary from response
   [claude-mem worker] Summary parsed successfully { hasRequest: true, hasLearned: true, ... }
   [claude-mem worker] Storing summary in database
   [claude-mem worker] Summary stored successfully in database
   ```

6. **Completion:**
   ```
   [claude-mem worker] SDK agent completed, marking session as completed
   [claude-mem worker] Cleaning up worker resources
   [claude-mem worker] Cleanup complete
   ```

## Issues and Concerns

### 1. Large Response Truncation
- Raw messages are truncated to 500 chars in socket logs
- Content previews are limited to 200-300 chars
- This prevents log spam but might make debugging harder if the critical info is beyond the truncation point

### 2. Async Generator Timing
- The generator waits in a loop (`while (!this.isFinalized)`) with 100ms sleeps
- Logs show when messages are queued but not when the generator processes them
- There could be a small delay between "FINALIZE message detected" and "Processing FINALIZE in generator"

### 3. Error Cases Not Fully Logged
- Parser errors in `parseObservations()` and `parseSummary()` are not logged
- Should consider adding try-catch in `handleAgentMessage()` to catch parser exceptions
- XML parsing errors would be silent

### 4. No Timing Information
- Logs don't include timestamps (relies on stderr default timestamps)
- Could add `Date.now()` or elapsed time to measure performance bottlenecks

### 5. Socket Path Permissions
- No logging for socket file permissions or creation errors
- If socket can't be created due to permissions, error might not be clear

### 6. Multi-Message Batching
- If multiple messages arrive rapidly, they're processed in a batch
- Logs show individual messages but don't indicate batch boundaries
- Could add batch ID or sequence numbers

## Recommendations for Next Steps

1. **Test the logging** by running the worker and sending various messages
2. **Add parser error handling** in `handleAgentMessage()` to catch XML parse failures
3. **Consider adding timing metrics** to measure latency at each stage
4. **Validate socket connectivity** early in startup (try writing a test message)
5. **Add structured logging library** if JSON logs would be easier to parse programmatically

## Related Files

- `/Users/alexnewman/Scripts/claude-mem/src/sdk/prompts.ts` - Prompt builders used in logged operations
- `/Users/alexnewman/Scripts/claude-mem/src/sdk/parser.ts` - XML parsers for observations and summaries
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/HooksDatabase.js` - Database methods being called
- `/Users/alexnewman/Scripts/claude-mem/src/shared/paths.js` - Socket path generation
