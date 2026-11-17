# Checked story and preference refreshes

My Work tells the story from saved request reviews. A large history must not turn
one story update into thousands of all-pairs model comparisons, and a failed late
batch must not discard answers that already passed validation.

## Source and admission

`pendingStoryReviews()` is shared by `story-input` and `refreshNeeds()`. Facts
whose `changedAt` (or an older review's `checkedAt`) is newer than the saved
story's `writtenAt` make a story due. This includes a story that failed after all
individual reviews were saved. Rechecking an unchanged review does not move its
fact timestamp.

The usual manual or configured My Work refresh remains the only entry point.
The private cache does not make work due, start a job at startup, add a timer,
change quota/auth admission, or bypass failure backoff. It stores checked
derived answers, not pending inference inputs or a queue of failed calls.

Narrative batches use the changed reviews. Preference reconciliation uses the
complete saved review history, including unchanged reviews, empty preference
lists, singletons, and preferences outside the displayed top 30. Raw reviews
and quotes remain in the existing ledger.

## Bounded semantic keys

When the full preference evidence will not fit beside a narrative batch, the
worker asks for independent semantic keys in pages of at most 64 distinct
complete values. Each pretty-printed JSON input is at most 256 KiB. An
indivisible oversized value fails explicitly; it is not shortened or skipped.

The answer is an assignment for every supplied ID, including singletons:

```json
{
  "assignments": [{
    "id": 0,
    "key": {
      "action": "run",
      "target": "tests",
      "condition": "before committing",
      "polarity": "require"
    }
  }]
}
```

The model's contract is to assign equivalent actionable preferences the same
key independently of the page, order, IDs, and support counts. Conditions,
exceptions, negative instructions, and case-sensitive identifiers remain
distinct. The validator checks the exact key shape and complete, unique ID
coverage. It does not lowercase, normalize Unicode, or collapse whitespace in
keys. The host joins equal full keys, counts distinct request IDs, and takes
quotes only from the original saved evidence.

Semantic equivalence is still a model judgment. This interface does not
guarantee recall of every possible paraphrase or prove that an arbitrary model
will choose consistent keys across calls. Deterministic fake-provider tests
verify coverage, budgets, persistence, and counting under the key contract;
they are not measurements of real-model semantic recall.

For 1,100 reviews with 10 distinct preferences each, ordinary-sized values need
172 successful canonicalization calls (`ceil(11000 / 64)`), instead of 3,655
page-pair comparisons. Larger values can make byte-limited pages smaller. A
saved story contributes at most 30 additional values. The existing one-repair
answer policy still applies: an invalid answer can cost a second attempt, and
a provider failure stops the run. Narrative calls are separate.

## Private checked results

`story-preferences/state.json` stays local and is written through a private
0600 temporary file, fsync, and rename. It is not a shared story record and is
never inserted into `previousStory` or a model input. It contains:

- Checked canonical keys indexed by a fingerprint of the complete immutable
  evidence value. Their context binds the plan/prompt contract, chosen agent
  and model settings, API target where applicable, device, and language.
- Checked narrative drafts bound to the complete source snapshot, base story,
  prompt context, and original read time.
- Request provenance for the current and prospective displayed preferences,
  bound to the full story fingerprint. Large request-ID sets stay here instead
  of growing the shared story's 48,000-byte value or narrative input.

A changed source invalidates narrative drafts. Unchanged immutable preference
values reuse checked canonical keys, so a small increment does not require
canonicalizing the full history again. A model/prompt context change clears
inference caches while keeping committed provenance. Failed validation is
never cached, and a failed cache write cannot advance checked progress.

Only a completed story is saved. Immediately before saving, the worker rereads
the source, base story, and device and refuses a changed snapshot. The original
read time survives a retry. The existing shared ledger `expectedHash`
transaction continues to arbitrate shared writes; the local snapshot check is
not a new cross-process compare-and-swap guarantee. This cache also cannot
guarantee exactly-once billing for a provider answer lost before it was checked
and persisted.

## Counts and old stories

Each checked preference proof records distinct stable request `groupId`s.
Three proven supporting requests plus two new ones produce five; re-reviewing
the same requests does not increase that count. Current saved reviews replace
their prior contributions, including an empty preference list that retracts a
vote. Existing proofs can retain known requests whose source review is not
present on this device. Singleton evidence and the 31st ranked preference
remain in the saved source and canonical cache and can qualify on a later
refresh. The 30-item cut is applied only after reconciliation.

Older stories have counts and a few quotes but no request IDs. The worker
rebuilds every support set it can prove from the full available saved reviews.
It never invents the unknown IDs or assumes the old count is disjoint from new
requests. An unverifiable old count is retained explicitly as
`legacySupportCount` in the private proof; displayed `supportCount` is then the
maximum of known distinct support and that historical lower bound. The
existing UI still displays that count, not a new exact/unknown indicator.
Exact addition applies to known request provenance; missing historical source
cannot be reconstructed from a bare number.

The prospective proof is persisted before the completed story, retaining the
baseline proof until the write succeeds. A storage failure can therefore
finish the checked save on the next authorized refresh without another model
call. Deleting the private cache loses this optimization and provenance; the
next due refresh rebuilds from saved reviews using the same legacy boundary.
