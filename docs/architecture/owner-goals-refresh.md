# Initial owner-goals mapping

My Work already asks the selected refresh agent to map the owner's prompt window
when no current goal snapshot exists. A large initial window is read in batches;
it is never replaced with a latest-prompts slice. Incremental updates of an
existing snapshot retain their existing path.

This is the historical owner-goals workflow, not live observation capture.
Only the normal manual or configured My Work refresh starts it. The checkpoint
does not schedule a task, react to a quota reset, add a provider, or retain a
failed inference input for replay. Each new refresh scans the original sources
again through the existing privacy and owner-authorship filters.

## Input and progress

A first map uses the existing single-call path when its complete question fits
640 KiB of UTF-8 input. This includes the inlined skill and the prompt and focus
files the agent must read, even when Claude Code receives file paths instead of
inline file contents. No mapping checkpoint is created for that path.

The limit is a byte heuristic based on the observations in
[#5969](https://github.com/thedotmack/claude-mem/issues/5969): per-quote misses
stayed roughly flat through 177k input tokens and rose at 289k and 444k. At a
nominal four UTF-8 bytes per token, 640 KiB is about 164k tokens. That conversion
is not a tokenizer guarantee or a provider maximum: text, language and model
change token density, and the report used one run per range. It is a reason to
bound unusually large maps, not evidence that a normal 200–500 KB window needs
many calls.

Above that complete-question limit, each batch contains at most 512 KiB of
exported prompt sections, reserving 128 KiB for the roughly 12 KB skill, saved
focus areas and cumulative draft. The actual remaining question space may
shrink a batch further. Every batch question and any retry with a refused answer
must still fit 640 KiB. If the checked aggregate and one prompt no longer fit,
the run stops with its progress retained. It does not silently remove goals or
skip source prompts to make them fit. These limits do not change provider
selection or the number of permitted attempts.

A source key commits to the agent, session, native message id, exact timestamp,
project context and full filtered prompt text. Equal text in different turns,
new turns in the same minute and edits to a processed turn remain distinguishable.
The minute in an exported heading is still the quote verifier's timestamp; it
is not the batch cursor.

Every nonempty cumulative answer uses the Python fresh-save rule against the
full current window: without `--carried-before`, unverified quotes and items
left without evidence are dropped; an answer with no surviving verified item
is refused. Shape checks and the focus route's pure preflight still apply.
Only after those succeed does one atomic checkpoint advance the processed
source keys, the cleaned aggregate and the reported `droppedUnverifiedQuotes`
(item labels and quote times, not the unverified words). The completed run
reports the drop count; the details remain available while its checkpoint
exists and are removed with that checkpoint after a successful save.
The next batch keeps the
aggregate's titles, rules, matches and evidence through the skill's update
contract. Batch maps are model-written audit notes, not quote-validated goal records, and
are not repeatedly sent to the model. Cached maps and descriptive quote-drop
reports are discarded when their source changes so redacted text is not
republished from audit prose.

Before any actionable goal has been found, a batch can return **goals: null**.
This records no snapshot or quote claim. A later batch cannot replace an
existing cumulative snapshot with null. A whole window with no actionable
goals keeps its completed source positions and lets the rest of the refresh
continue, without forcing an unsupported empty snapshot through the validator.

On another refresh, checked draft quotes are revalidated against the new
export. The existing carried-quote cleanup may remove evidence that aged out
or was redacted. This carried-quote boundary is separate from a fresh answer's
reported cleanup; a normal incremental update still refuses invalid new quotes.
Completed source
positions survive an empty aggregate while those sources are still in the
current export. Absent or changed keys are removed so a later restoration is
not suppressed by an obsolete position. New or changed source keys still need
processing.

## Finishing a checked snapshot

After every current source turn is covered, the checkpoint retains the complete
checked goal payload and a focus save key. There is no further model work for
that snapshot. Its **generated_at** is the time captured before the source scan,
not the time the final network write eventually succeeds.

The optional focus route key is a random nonce followed by a SHA-256 commitment
to its normalized area tuples (name, goal, rank, matches, evidence). The complete
key is verified before writing. A different payload under that same key is
refused. Derived area ids bind the key and index to the worker's home-project
and local-device scope. A retry explicitly matches already written ids and
creates only the missing ones. Existing owner renames, dismissal and merges
remain owner decisions; withdrawn ids are never resurrected. No separate
receipt can get out of step with a partially appended suggestion request.

Saving writes focus suggestions, goal items, stale-item drops and rules before
advancing the list's **generated_at** watermark. Rules reread the current story
and replace only owner-goals suggestions. These operations are not a cross-store
transaction: an interruption can leave partial rows, but cannot mark unfinished
work as a complete snapshot. The retained immutable payload can finish those
writes without another model call or another set of focus ids.

A retry still validates against the **current** prompt export. With a save key,
any validator mutation (including automatic quote aging) is refused before a
write, as is an invalid quote. Deleted, excluded or redacted evidence cannot be
revived from an old frozen prompt file. Such a refusal retains the checkpoint
for inspection instead of silently changing its payload/key or paying to map
the window again. New prompts that leave the checked evidence intact do not
block saving; the original watermark leaves those prompts due for the next
inclusive-minute incremental export.

The checkpoint is private to this workflow and is removed only after the save
succeeds. A different saved snapshot or local device during mapping refuses
recovery rather than overwriting that newer state. These snapshot checks guard
each batch and final save; they are not an atomic cross-process compare-and-set
across the separate HTTP writes. It is not an exactly-once billing guarantee for an unanswered in-flight provider request: only completed,
validated answers can be reused.
