# Adapters

Claude Code hook payloads are mapped through `src/adapters/claude-code/mapper.ts` into `AgentEvent` records. The mapper preserves legacy fields such as `contentSessionId`, `tool_name`, `tool_input`, `tool_response`, `cwd`, `agentId`, `agentType`, `platformSource`, and both `tool_use_id` and `toolUseId`.

Generic agent examples live in `src/adapters/generic-rest/examples.ts` for Codex, OpenCode, and custom REST ingestion. New adapters should emit the REST V1 event shape instead of coupling their payloads to Claude Code internals.
