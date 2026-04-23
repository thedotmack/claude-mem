# Flowchart: privacy-tag-filtering

## Sources Consulted
- `src/utils/tag-stripping.ts:1-92`
- `src/services/worker/http/routes/SessionRoutes.ts:1-900`
- `src/services/worker/SessionManager.ts:270-360`
- `src/services/sqlite/PendingMessageStore.ts:1-100`
- `src/cli/handlers/summarize.ts:1-150`
- `src/shared/transcript-parser.ts:1-130`

## Happy Path Description

User submits a prompt containing `<private>` tags via hook → Worker HTTP endpoint `/api/sessions/init` receives request → `SessionRoutes.handleSessionInitByClaudeId` (line 814) validates and extracts the prompt. At line 862, `stripMemoryTagsFromPrompt()` is called, which invokes `stripTagsInternal()` to remove six tag types: `<claude-mem-context>`, `<private>`, `<system_instruction>`, `<system-instruction>`, `<persisted-output>`, and `<system-reminder>`. The cleaned prompt is saved to `user_prompts`. Concurrently, tool observations flow through `handleObservationsByClaudeId` (line 565), where `tool_input` and `tool_response` are stringified and stripped via `stripMemoryTagsFromJson()` (lines 629, 633), then queued to `PendingMessageStore` as already-cleaned data.

Stripping occurs BEFORE persistence, ensuring the database never receives unfiltered content. However, the **assistant-message summarize path** only strips `<system-reminder>` at extraction time (summarize.ts:66), not the full suite — a known gap.

## Mermaid Flowchart

```mermaid
flowchart TD
    Start([User prompt with tags<br/>SessionRoutes.ts:814]) --> Init["handleSessionInitByClaudeId<br/>SessionRoutes.ts:814"]
    Start2([Tool invocation completes<br/>SessionRoutes.ts:565]) --> ObsRoute["handleObservationsByClaudeId<br/>SessionRoutes.ts:565"]
    Start3([Session stops, summarize<br/>summarize.ts:66]) --> Extract["extractLastMessage stripSystemReminders=true<br/>summarize.ts:66"]

    Init --> StripPrompt["stripMemoryTagsFromPrompt<br/>SessionRoutes.ts:862"]
    StripPrompt --> StripInternal1["stripTagsInternal (all 6 tags)<br/>tag-stripping.ts:51"]
    StripInternal1 --> RemoveTags1["Remove private, claude-mem-context,<br/>system_instruction, system-reminder,<br/>persisted-output, system-instruction<br/>tag-stripping.ts:53-59"]
    RemoveTags1 --> CheckEmpty{Empty?<br/>SessionRoutes.ts:865}
    CheckEmpty -->|Yes| SkipPrivate["Return skipped=true<br/>SessionRoutes.ts:872"]
    CheckEmpty -->|No| SavePrompt["saveUserPrompt<br/>SessionRoutes.ts:882"]
    SavePrompt --> DBPrompt["INSERT user_prompts<br/>SessionStore.ts"]

    ObsRoute --> ExtractObs["Extract tool_input, tool_response<br/>SessionRoutes.ts:587"]
    ExtractObs --> StripInput["stripMemoryTagsFromJson input<br/>SessionRoutes.ts:629"]
    StripInput --> StripInternal2["stripTagsInternal<br/>tag-stripping.ts:51"]
    StripInternal2 --> StripResponse["stripMemoryTagsFromJson response<br/>SessionRoutes.ts:633"]
    StripResponse --> StripInternal3["stripTagsInternal<br/>tag-stripping.ts:51"]
    StripInternal3 --> QueueObs["queueObservation<br/>SessionRoutes.ts:637"]
    QueueObs --> EnqueueDB["PendingMessageStore.enqueue<br/>PendingMessageStore.ts:63"]
    EnqueueDB --> DBObs["pending_messages cleaned"]

    Extract --> PartialStrip["SYSTEM_REMINDER_REGEX only<br/>shared/transcript-parser.ts:84"]
    PartialStrip --> SummarizeRoute["handleSummarizeByClaudeId<br/>SessionRoutes.ts:669"]
    SummarizeRoute --> QueueSum["queueSummarize last_assistant_message<br/>SessionRoutes.ts:705"]
    QueueSum --> PendingSum["pending_messages with INCOMPLETE strip"]

    style PartialStrip fill:#fff9c4
    style PendingSum fill:#fff9c4
    style StripPrompt fill:#c8e6c9
    style StripInput fill:#c8e6c9
    style StripResponse fill:#c8e6c9
```

## Call Sites Inventory

| Location | Function | Data Protected | Tag Types | Entry |
|---|---|---|---|---|
| `SessionRoutes.ts:862` | `stripMemoryTagsFromPrompt()` | User prompts | All 6 | handleSessionInitByClaudeId |
| `SessionRoutes.ts:629` | `stripMemoryTagsFromJson()` | Tool inputs | All 6 | handleObservationsByClaudeId |
| `SessionRoutes.ts:633` | `stripMemoryTagsFromJson()` | Tool responses | All 6 | handleObservationsByClaudeId |
| `transcript-parser.ts:84` | `SYSTEM_REMINDER_REGEX` | None (read-time) | system-reminder only | Context extraction |
| `transcript-parser.ts:128` | `SYSTEM_REMINDER_REGEX` | None (read-time) | system-reminder only | Context extraction |
| `summarize.ts:66` | `extractLastMessage(..., true)` | Assistant msgs (summary path) | system-reminder only | Hook summarize handler |
| `SessionRoutes.ts:378` (LEGACY) | `handleObservations()` | Tool observations | **NONE** | Unused endpoint |

## Side Effects

- **ReDoS protection**: counts tags before regex, warns if > MAX_TAG_COUNT=100 (tag-stripping.ts:56-60).
- **Whitespace trim** after all replacements (tag-stripping.ts:65).
- **Multiple regex passes** — one per tag type. Could be unified.

## External Feature Dependencies

- **PrivacyCheckValidator** (SessionRoutes.ts:614) — after stripping, validates empty-result handling.
- **PendingMessageStore** — receives pre-cleaned data; no re-strip.
- **ResponseProcessor** — consumes pending messages; no re-strip.
- **ChromaSync** — operates on already-sanitized text from DB.

## Confidence + Gaps

**High confidence:** User prompts + tool observations fully stripped before DB write; ReDoS protection active.

**Known gaps:**
1. Assistant messages in summary path only strip `<system-reminder>`, not full suite (summarize.ts:66, SessionRoutes.ts:669).
2. Legacy endpoint `SessionRoutes.ts:378` has no stripping — stale route.
3. `stripTagsInternal` is called from two public wrappers (`stripMemoryTagsFromPrompt`, `stripMemoryTagsFromJson`) that differ only by caller context — minor DRY violation.
