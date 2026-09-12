# 02 — TITANS Conversation Observer

**Branch commits:** `17984f37` (Phase 4 — initial observer + fire-and-forget endpoint), `4eb23b7b` (route through SessionManager pipeline).

---

## 1. What the feature is

A second observation modality that watches the **raw conversation** between user and assistant, instead of (or alongside) tool-use events. Where the existing pipeline asks an SDK agent _"what happened in this tool call?"_, TITANS asks _"what happened **between the people**?"_ — sentiment, corrections, overconfident claims, surprise, frustration.

The work landed in two waves:

- **Wave 1 (`17984f37`)** — added the prompt (`buildConversationObservationPrompt` in `src/sdk/prompts.ts:274-332`), a `OneShotQuery` utility, and a fire-and-forget `POST /api/sessions/conversation-observe` endpoint that called the LLM directly and bypassed the queue.
- **Wave 2 (`4eb23b7b`)** — refactored Wave 1 to flow through the existing `SessionManager → ClaudeProvider/SDKAgent → ResponseProcessor` pipeline so conversation observations get the same SQLite persistence, claim-confirm, Chroma sync, SSE broadcast, and conversation-history continuity that tool observations get.

---

## 2. What we want it to do

The TITANS prompt (`src/sdk/prompts.ts:285-331`) tells the agent to emit `<observation>` blocks for these **seven types**, with these triggers:

| Type | Trigger |
| --- | --- |
| `insight` | Surprise, delight, unexpected discovery |
| `commitment` | "I'll remember this", "Got it", "Won't do that again" |
| `correction` | User corrected behavior; assistant acknowledged |
| `frustration` | User pain, dissatisfaction, repeated requests |
| `pattern_recognition` | "This is similar to…", connecting dots |
| `emotional_signal` | Strong sentiment in conversation flow |
| `overconfidence` | Assistant made declarative claims with no preceding evidence (no file reads, no greps), no hedging |

Subvariant called out under `overconfidence`: **`unverified_inference`** — same gap (no evidence) but the assistant *did* hedge ("I think", "it seems"). Same priority, captured in `<subtitle>`.

**Trigger point in the system:** `TranscriptEventProcessor` (`src/services/transcripts/processor.ts`) accumulates `ConversationExchange{promptNumber, userText, assistantText}` per session and calls `flushTranscriptSegment()` (line 369) on every prompt boundary. After persisting the transcript chunk for Layer 3 traversal, it fires `fireConversationObservation()` (line 417) — a fire-and-forget POST of the exchanges to `/api/sessions/conversation-observe`.

**Pipeline path on this branch (post-wave-2):**

```
TranscriptEventProcessor.flushTranscriptSegment
  → POST /api/sessions/conversation-observe
    → SessionRoutes.handleConversationObserve  (SessionRoutes.ts:1047)
      → SessionManager.queueConversation       (SessionManager.ts:329)
        → PendingMessageStore.enqueue (type='conversation', exchanges in tool_response)
        → emitter.emit('message')
        → SDKAgent dispatch branch              (SDKAgent.ts:441)
          → buildConversationObservationPrompt
          → conversationHistory.push(role:'user', content:prompt)
          → yield to provider → ResponseProcessor → SQLite + Chroma + SSE
```

---

## 3. What we want it to accomplish

Tool-use observations are **act-based** — they record _what changed in the world_. TITANS observations are **affect- and claim-based** — they record _how the conversation felt_ and _which assistant claims were unverified_.

Concretely, this unlocks:

- **Behavior change in future sessions.** When mem-search surfaces a `correction`, the next agent sees "user told you X — don't repeat the mistake." This is the closest claude-mem gets to learning from user feedback.
- **Overconfidence discipline.** The unverified-claim flagger is the project's first introspective signal — it lets future sessions notice "last time I confidently said Y without checking, and I was wrong." This is the seed of an evidence-first culture and was explicitly added in v17984f37.
- **Emotional context for triage.** A run that emitted `frustration` deserves more careful re-engagement than one that emitted `insight`. Useful for Pro UI surfacing and for retros.
- **Replaces nothing.** Tool observations stay. TITANS adds a _second axis_.

Prior observation (66784, Apr 10) confirms TITANS types were missing in production for weeks — meaning we already learned the hard way that the prompt has to be wired into a path that actually fires.

---

## 4. Why we think it will work

- **The LLM is provably good at this.** Conversational sentiment / claim-vs-evidence judgment is exactly what frontier models excel at; we're not asking for novel reasoning, we're asking for textual classification.
- **Re-uses the proven pipeline.** Wave 2 deliberately collapsed the modality onto `PendingMessageStore` + `SessionManager` + provider dispatch — the same code path that has handled tool observations for months. Crash-safety, idempotency, SSE broadcast are inherited for free.
- **Natural batching.** Prompt boundary is the right cadence — exchanges since the last user turn are the natural analysis unit. Avoids per-token streaming complexity and avoids duplicate fires.
- **Empty response is a valid output.** The prompt explicitly says "Skip routine exchanges" — most prompt boundaries cost nothing because the LLM returns an empty block.

---

## 5. The simplest possible implementation

If we ignored the existing codebase, queue, and edge cases entirely:

```ts
// One file. ~50 LoC.
app.post('/api/sessions/conversation-observe', async (req, res) => {
  const { contentSessionId, exchanges, project } = req.body;
  res.json({ accepted: true });               // fire-and-forget

  const prompt = buildConversationObservationPrompt(exchanges, mode);
  const xml = await oneShotQuery(prompt);     // any provider, ~5s
  const observations = parseObservations(xml);
  for (const obs of observations) {
    db.insert('observations', { ...obs, memory_session_id: contentSessionId, project });
  }
});
```

That's it. No queue, no claim-confirm, no migration, no provider dispatch, no SSE. Single endpoint, single LLM call, direct insert.

This is essentially **Wave 1** (commit 17984f37) before Wave 2 reworked it.

---

## 6. Is the simple way better or worse than what we designed?

**Honestly: the simple way is better right now, and the queued version is better later.**

| Concern | Simple (Wave 1) | Queued (Wave 2 — current branch) |
| --- | --- | --- |
| LoC to ship | ~50 | ~300+ across 6 files |
| Crash safety | None — in-flight obs lost on worker restart | Full — survives restart via SQLite |
| Real-time SSE to viewer | No | Yes |
| Idempotency on retry | No | Yes (claim-confirm) |
| Conversation-history continuity across providers | No | Yes |
| Failure modes if LLM hangs | One stuck request | Queue depth blows up, generator stays alive |
| Time to first signal in production | hours | days |
| Time to debug an issue | minutes | hours (multi-file flow) |

The queued design is correct **once we know users rely on TITANS observations being durable and broadcast in real time.** Until that's validated, Wave 1's complexity premium isn't earning anything. Observation 66784 (Apr 10) shows we shipped Wave 1, watched zero TITANS observations land, and still had to debug — Wave 2's pipeline integration didn't save us from that. The lesson: the cost of Wave 2 is paid up-front; the benefit only materializes after adoption.

---

## 7. Suggestions for how to continue

See `00-handoff.md` §"TITANS corrections" and `06-execution-plan.md` Phase 1 for the current approach.

---

## 8. Overlap / conflict notes vs `origin/main`

| File on branch | Status on `origin/main` (v12.5.0) | Action |
| --- | --- | --- |
| `src/services/worker/SDKAgent.ts` | **Renamed → `ClaudeProvider.ts`** by PR #2255 | Apply branch's conversation-dispatch diff to `ClaudeProvider.ts`, not the old name |
| `src/services/worker/GeminiAgent.ts` | **Renamed → `GeminiProvider.ts`** | Same |
| `src/services/worker/OpenRouterAgent.ts` | **Renamed → `OpenRouterProvider.ts`** | Same |
| `src/services/worker-types.ts` | `PendingMessage` union has only `'observation'\|'summarize'`; gained `toolUseId?` field | Add `'conversation'` and `exchanges?` while preserving `toolUseId?` |
| `src/services/sqlite/PendingMessageStore.ts` | Now writes `tool_use_id` column on enqueue | Compatible — no change needed |
| `src/services/sqlite/migrations/runner.ts` | Migration 28 = self-healing claim rebuild; latest = 31 | Branch's migration 28 (CHECK widening) must be **renumbered to 32** |
| `src/services/worker/SessionManager.ts` | No `queueConversation` | Add the method (line 329 pattern) |
| `src/services/worker/http/routes/SessionRoutes.ts` | No `handleConversationObserve` | Add it; route at line 390 |
| `src/services/worker/OneShotQuery.ts` | Does not exist | Create new (only needed if Phase 0 ships) |
| `src/services/transcripts/processor.ts` | 389 LoC; **no conversation hooks** | Re-add `ConversationExchange` interface, `exchanges: []` field, `fireConversationObservation()` |
| `src/sdk/prompts.ts` | No `buildConversationObservationPrompt` | Append; no conflicts |
| `src/services/worker/ClaudeProvider.ts` (and Gemini/OpenRouter) | Dispatch handles `observation`+`summarize` only | Add `'conversation'` branch in all three |

**No semantic overlap** with main's queue/anti-pattern/UX-redesign work — the conflict surface is purely additive in the `'conversation'` direction. The dangerous-looking 23-file merge from yesterday (obs 78072) was almost entirely `Provider` rename collisions and migration-number collisions; once those two are resolved, the actual code re-application is small.
