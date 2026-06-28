# Prompt Clarity Scorer

A pre-flight gate for prompts. Before Claude ever sees what you typed, a lightweight scorer evaluates the prompt across clarity dimensions, assigns a score, and — if the score is low — surfaces targeted follow-up questions that get answered *before* the main turn runs.

The goal is not to nag. The goal is to catch the failure modes that waste the most tokens: ambiguous referents ("fix it"), missing scope ("make it better"), unstated constraints ("add a button" without where, what color, what behavior), and unclear success criteria ("when it's done").

---

## 1. Why this matters

Most agent failures are not capability failures. They are **specification failures**. The agent did exactly what was asked. What was asked was not what was wanted.

The cost compounds:

- The agent guesses. It guesses wrong ~30% of the time on ambiguous prompts.
- The user reviews the output. Wrong direction.
- The user re-prompts. "No, I meant..."
- The agent re-does the work. Tokens, time, context window burned.
- Sometimes the user gives up and does it themselves.

A 200ms clarity check that catches even half of these saves enormous amounts of downstream work. The economics are obvious: cheap scoring upstream beats expensive regeneration downstream.

This is the same principle behind compile-time type checks vs. runtime errors. Catch the bug where it's cheap.

---

## 2. The dimensions

A clarity score is not one number. It's a vector across distinct failure modes. Five candidate dimensions:

**1. Referential clarity (0-10)**
Does every pronoun and demonstrative ("it", "this", "that", "the one") have an unambiguous referent? "Fix it" with no prior turn scores 0. "Fix the SearchManager constructor at line 47" scores 10.

**2. Scope definition (0-10)**
Is the boundary of the task clear? "Refactor the codebase" scores 2. "Refactor src/services/sqlite/ to use the new migration pattern from src/services/migrations/" scores 9.

**3. Success criteria (0-10)**
How will we know it's done? "Make it faster" scores 1. "Reduce p95 query latency below 50ms, measured by the existing benchmark suite" scores 10.

**4. Constraint surfacing (0-10)**
Are the things-it-must-not-do stated? "Add a logging endpoint" with no mention of auth, rate limits, or PII handling scores 4. The same prompt with "no PII in logs, gated behind the existing admin middleware" scores 9.

**5. Context completeness (0-10)**
Does the agent have what it needs to start? "Use the same pattern as before" without saying which pattern scores 3. With a file path or commit reference, scores 9.

Composite score is a weighted sum. Weights tune based on observed failure modes — initially equal, learned over time.

---

## 3. Architecture

Three components:

**The Scorer**
A small, fast model (Haiku 4.5, or a fine-tuned local model) runs as a UserPromptSubmit hook. Input: the prompt + recent conversation context. Output: a JSON blob with per-dimension scores, total score, and a list of specific clarity gaps.

Budget: 200-400ms, <1000 tokens per scoring pass. This is the critical constraint. If it's slow, users will disable it.

**The Gate**
A threshold function. If score > 7, pass through silently. If score is 5-7, inject a "soft" clarifying preface ("Note: I'm interpreting X as Y — say if that's wrong") and proceed. If score < 5, *block* the prompt and surface follow-up questions via AskUserQuestion before running the main turn.

The gate is configurable. Power users want fewer interruptions; new users want more guardrails. Per-user, per-project, even per-skill thresholds.

**The Learner**
Every scored prompt becomes training data. We track: did the user accept the agent's first output? Did they re-prompt? Did the conversation contain an "actually I meant..." correction? These signals retroactively label whether the score was right.

Over time, the scorer learns the user's idiolect. "Fix the thing" from a user who has consistently meant "fix the most recent failing test" is no longer ambiguous *to this user*. The scorer becomes personalized.

---

## 4. The follow-up question design

This is where most "ask clarifying questions" systems fail. They ask too many, or too generic, or at the wrong moment.

Rules:

1. **Maximum two follow-ups per prompt.** More than that, the user feels interrogated and disables the tool.

2. **Questions must be specific and offer concrete options.** Not "what do you mean by fix?" but "Which behavior should change? (a) the 500 error on POST, (b) the slow query on GET, (c) something else."

3. **Defaults must be sensible.** Every follow-up offers a recommended option marked clearly. Hitting enter does the most-likely thing.

4. **Never ask if confidence is high enough.** A score of 7 with one ambiguity is *not* a follow-up moment — it's an inline clarification: "Interpreting X as Y, proceeding."

5. **The follow-up is part of the prompt, not separate.** When the user answers, the *combined* prompt + answer goes to the agent as a single, fully-specified turn. The agent doesn't see the score or the original ambiguous version. It sees a clean, scored-10 prompt.

---

## 5. Failure modes of this idea

Honest reckoning. The ways this could go wrong:

**Latency tax.** Every prompt now waits for the scorer. Even 200ms is noticeable. Mitigation: run scoring in parallel with the main turn for high-confidence prompts; only block if the scorer returns a low score before the main turn has produced useful work.

**Annoying user experience.** "Stop asking me questions, just do the thing." Mitigation: aggressive personalization, easy disable, and the per-dimension threshold tuning. Users who want zero friction should be able to get it.

**Wrong follow-ups.** The scorer asks about the wrong ambiguity, missing the real one. Mitigation: this is what the Learner exists for. Wrong follow-ups become training signal. Also: never ask if confidence is moderate — just proceed with an inline note.

**Gaming the metric.** Users start writing pseudo-formal prompts to satisfy the scorer, not because formality helps. Mitigation: the scorer is *advisory*, never required. The metric should reflect downstream success, not surface formality.

**The scorer itself is wrong.** A small model misjudging clarity. Mitigation: the score is a probability distribution, not a verdict. The threshold is conservative. False positives (asking when not needed) cost a question; false negatives (not asking when needed) cost a regeneration. Tune for the cheaper failure.

---

## 6. Why this fits claude-mem

Claude-mem already runs UserPromptSubmit hooks. It already has cross-session context about how the user phrases things. It already has the worker service, the SQLite store, and the observation pipeline.

The Learner can ride on top of the existing observation infrastructure. Every prompt's score becomes an observation. Every "actually I meant" correction becomes a labeled signal. The cross-session memory means the personalization is *real* — not per-conversation, but per-user, accumulating over months.

The viewer UI can show clarity trends. "Your prompts scored 6.2 average this week, up from 5.8 last week." Or "Your most common clarity gap is missing scope — try specifying paths." This is dogfoodable. It's the kind of thing that makes the tool stick.

---

## 7. Open questions

- Should the scorer run server-side (in the worker) or inline in the hook?
- Is there a "no-score" escape hatch — a prefix like `!` that bypasses the gate entirely?
- How do we handle multi-turn prompts where clarity is supposed to be partial? Conversations build up context; an early-turn prompt that scores low might be perfectly fine.
- Do we expose the score to the agent itself? Could be useful ("the user is being vague — ask before acting"), could be harmful (the agent argues with the score).
- What's the right onboarding? Most users won't know this exists. Surface it the first time it catches something useful.

---

## 8. Minimum viable test

Two weeks of work:

1. Add a UserPromptSubmit hook that calls Haiku with a fixed prompt template and gets back a JSON score.
2. Log every score. Don't gate anything yet.
3. After a week, look at the data. Did low scores predict re-prompts? Did high scores predict first-try success?
4. If signal exists, add the gate and one follow-up question for the lowest-scoring 10% of prompts.
5. Measure: does this reduce total turns-per-task?

That's the test. Build the minimum that produces a signal. Decide based on the signal.

---

## 9. The bigger frame

This is one instance of a general pattern: **agents should grade their inputs, not just produce outputs.** Today's agents accept any prompt and try their best. Tomorrow's agents will recognize when a prompt is under-specified and route accordingly — sometimes by asking, sometimes by inferring, sometimes by proceeding with an explicit acknowledgment of the gap.

Clarity scoring is the first step. The same machinery — score, gate, learn — applies to plans before execution, to code before commits, to deployments before release. Pre-flight checks at every boundary where cheap evaluation beats expensive regeneration.

The unlock is not "ask more questions." The unlock is **knowing when to ask**.
