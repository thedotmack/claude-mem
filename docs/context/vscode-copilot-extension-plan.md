# VS Code Copilot Extension Integration Plan

## 1. Groundwork
- Audit existing claude-mem hook scripts (`context-hook`, `user-message-hook`, `new-hook`, `save-hook`, `summary-hook`, `cleanup-hook`) and their worker-service payloads.
- Document REST endpoints, request bodies, and SessionStore schema fields used today so the extension mirrors them exactly.
- Confirm worker service availability workflow (`ensureWorkerRunning`, port resolution) and decide how extension error reporting will surface issues to Copilot chat users.

## 2. Project Scaffold
- Clone the VS Code `chat-sample` starter, convert to a TypeScript-only extension, and align lint/tsconfig with repo standards.
- Add build pipeline (esbuild or webpack) plus npm scripts that match the existing `scripts/build-hooks.js` release flow.
- Wire extension activation events for chat participation and ensure packaging metadata (publisher, categories) is in place.

## 3. Shared Worker Client
- Extract reusable worker-service client utilities from `plugin/scripts/*.js` (port discovery, session init, observation uploads).
- Publish TypeScript definitions by re-exporting from `src/services/worker-types.ts` to keep contracts synchronized.
- Centralize HTTP calls (timeouts, retries, logging) so every tool implementation uses the same helper layer.

## 4. Language Model Tool Contracts
- Add `contributes.languageModelTools` entries in `package.json` for lifecycle parity:
  - `mem_session_init`, `mem_user_prompt_log`, `mem_observation_record`, `mem_summary_finalize`, `mem_session_cleanup`.
- Provide detailed JSON schemas mirroring hook input structures (session IDs, cwd, prompt text, tool payload metadata).
- Supply descriptive `modelDescription`, `userDescription`, icons, tags, and enable `canBeReferencedInPrompt` where appropriate.

## 5. Tool Implementations
- Register each tool via `vscode.lm.registerTool` inside `activate`.
- Implement `prepareInvocation` to show user confirmations (especially for cleanup/stop actions) and tailor messages to match existing CLI prompts.
- In `invoke`, call the shared worker client, translate successes into `LanguageModelToolResult` text parts, and craft error messages that guide the LLM toward recovery (retry, alternate parameters).
- Ensure telemetry/logging records tool usage for debugging without leaking sensitive data.

## 6. Chat Orchestration
- Implement a chat participant based on the sample that maps Copilot threads to claude-mem session IDs stored in turn metadata.
- On conversation start, auto-run `mem_session_init`; before each user prompt, dispatch `mem_user_prompt_log`; when Copilot signals stop, run `mem_summary_finalize` (with fallbacks if the worker is unavailable).
- Capture tool events emitted by Copilot (file edits, terminal runs) and forward them through `mem_observation_record` with matching payload structure.
- Handle conversation disposal or model changes by calling `mem_session_cleanup` to mirror `SessionEnd` hooks.

## 7. Settings and UX
- Read `.claude-mem/settings.json` overrides (worker port, observation depth) and surface VS Code settings for Copilot-specific toggles (auto-sync enabled, max observations per prompt).
- Add status bar indicator/commands for worker health, quick restart instructions, and opening the viewer UI (`http://localhost:37777`).
- Provide inline notifications when the worker is unreachable, including guidance to restart via PM2.

## 8. Testing and QA
- Draft manual validation checklist: initial session, prompt logging, observation capture, summary completion, worker-down handling.
- Add integration tests using `@vscode/test-electron` to simulate chat turns and assert database side effects in a temporary claude-mem data directory.
- Build mocks for worker endpoints to enable unit tests of tool invocation logic without hitting the real service.

## 9. Release Readiness
- Document installation and usage in `README.md`, including architecture diagrams showing Copilot → tool → worker flow.
- Update CHANGELOG and marketing copy to announce Copilot support and list prerequisites (worker running, settings file placement).
- Prepare Marketplace assets (icon, gallery text) and extend existing publish scripts to package and ship the new extension.
