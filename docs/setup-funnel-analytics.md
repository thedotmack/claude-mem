# Local setup funnel

These events measure the nine screens shown by `npx claude-mem install`, at the
local worker's `/?setup=1`. They are not page views on cmem.ai. There is no
historical backfill; older installers emit none of these events.

`setup_funnel_version = 1` identifies this contract. The installer creates a
fresh UUIDv4 `setup_flow_id` for each browser setup attempt and saves it with
the live setup session. All events use `setup:<UUID>` as their PostHog distinct
ID. This identity is separate from the worker's persistent anonymous ID.
Current telemetry consent is checked on every worker request and capture;
the flow ID is forwarded to installer OAuth only when telemetry is allowed.
Sample previews never request a telemetry context or emit events.

## Screens and branches

`scan → reveal → choice → savings → checkout → finish-setup → launch → workspace`

- At Home and existing Pro configurations skip checkout. `already_pro` is the
  configuration present before setup, not a payment or subscription check.
- Initial `branch: go` is the UI default, not a decision. `branch_confirmed`
  becomes true only after the worker accepts the choice leaving Savings.
  Attribute earlier visits using the flow's latest confirmed choice. Flows
  without one remain undecided.
- Finish Setup can enter `import` and return. Successful import is a forward
  transition; failed import returns back. Import is optional and may be skipped.
- Reduced motion skips `launch` and moves directly to `workspace`.
- A return to a screen creates a fresh visit. A hidden tab does not.

## Events

Every event includes `setup_flow_id`, `setup_funnel_version`, `event_id`,
`visit_id`, `step`, `branch`, `already_pro`, and `branch_confirmed`. The worker
uses the captured event time for PostHog's timestamp. Identifiers are random;
no prompts, paths, URLs, tokens, selected tool lists, or exception text are sent.

- `setup_step_viewed`: a screen actually rendered, with a new `visit_id`.
- `setup_step_transitioned`: the originating visit plus `to_step` and
  `direction: forward | back`. Each visit has at most one exit.
- `setup_step_action`: a closed action code, including `choice_committed`,
  `choose_memory`, `open_checkout`, `start_import`, `skip_import`, `retry_scan`,
  `upload_allowed`, and `upload_skipped`.
- `setup_step_error`: a closed `error_code`; never the error message.
- `setup_page_hidden`: the browser left or hid the page. It does not prove
  abandonment or its cause.
- `setup_completed`: emitted with `workspace → complete` only after the worker
  successfully saves setup completion. Both retain the workspace visit ID.

Count distinct visits on `setup_step_viewed`, then join the first transition
by flow and originating visit ID. Group progression by the view's date, not
the transition date. Unknown means no next step was recorded; do not label it
a cancellation. Keep the shared pre-choice trunk, Home, Go, and existing
configuration branches separate, and never count skipped optional screens as
failures. A checkout screen visit or setup completion is not proof of payment.

The worker accepts events only from its same-origin local UI and validates
every property. Structural events bypass daily aggregation so visit joins
remain possible. Completion travels with the successful completion request,
before the installer can remove its session or restart the worker.
Unacknowledged events (up to 200) accompany completion as one validated batch,
so a slow local telemetry request cannot leave a recorded completion without
its screen visits. Event IDs deduplicate that batch against concurrent sends.
Temporary context-read failures retry without delaying setup; an explicit
disabled/no-session response stops the retry loop.

Tests: `bun test tests/telemetry/setup-funnel.test.ts
tests/worker/http/routes/setup-telemetry-routes.test.ts
src/ui/my-work/src/setup/setup-telemetry.test.ts` plus the existing setup and
installer tests. After release, verify real events from a consenting installer.
