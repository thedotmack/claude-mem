# Local My Work browser verification

Verified on October 17, 2026 against the SQLite fixture servers at
`http://127.0.0.1:37842/` and `http://127.0.0.1:37843/`. These contain synthetic
records only. No real memory database, cloud account, or agent conversation was
changed during browser checks.

## Result

Ready for the candidate commit. No remaining blocker was found in the checked
local-view, review, handoff, or narrow-layout behavior.

## Verified behavior

- An explicit completed request appears as **Ready to check**. Mark checked saves
  a local human review, moves the counts and handoff queue, and restores focus to
  the request card. The source lifecycle remains separate.
- The saved check survives a page reload. The card's Undo restores Ready to
  check. Neither operation creates an unread-work dot on its own.
- New recorded work is shown as soon as it arrives, even while a request/source
  dialog is open. The existing original request and source text stay in place,
  request order is preserved, and changed cards get the separate unread indicator.
- The original human request and source-record disclosure remain accessible.
  Reading a synthetic prompt source displays the original text. Hostile fixture
  contributor text renders as text rather than executable markup.
- Searching for `viewer` scopes the request count, status counts, and handoff
  queue together. The latest build also exposes Other states explicitly and a
  project selector when multiple projects are present; the focused presentation
  regressions cover those final additions.
- **Connect ChatGPT** opens an optional setup dialog with the existing
  `https://cmem.ai/connect?from=local-work` destination and sharing-scope copy.
  Opening or dismissing the dialog does not connect an account or send memory.
- **Copy handoff** success was also checked by the release owner. Independently,
  the failure path was verified by temporarily making `navigator.clipboard`
  reject within the isolated fixture tab using the Chrome DevTools console
  operated through CUA. Clicking Copy handoff showed the explicit clipboard
  unavailable message and a visible, focused, read-only text area. All 422
  characters were selected and available for manual copying. Reloading cleared
  the temporary test override.

## Responsive measurements

The native Chrome window-resize capability initially stopped at 521 CSS px.
That was not treated as a 390 px test. Final narrow checks used Chrome's device
toolbar, operated through CUA, and read-only DOM measurements on the final
rebuilt assets:

| Actual viewport | Document scroll width | Furthest card right edge | Result |
| --- | --- | --- | --- |
| 390 × 652 CSS px | 390 px | 368 px | No horizontal page overflow |
| 320 × 652 CSS px | 320 px | 298 px | No horizontal page overflow |

The native device toolbar kept the available emulated height at 652 px; no
844 px height claim is made for these final checks. Status tabs retain their
own horizontal scrolling at narrow widths. The clipboard failure dialog was
also exercised at 320 px without widening the document. Desktop interaction
checks were run at 1463 CSS px wide.

Device emulation was disabled, the temporary clipboard override was removed by
reload, and the isolated test tab was closed after verification.

## Related code verification

The release owner reported 41 new focused cases and 115 scoped cases passing,
including the request projection, review-store, origin, unavailable-source,
and current-source-order regressions. The independent presentation run during
this review also passed all 8 cases then present. Final asset rebuild and
non-generated whitespace verification run immediately before the candidate
commit.

## TeamBrain shared workspace verification

Independently verified on October 17, 2026 against the isolated, representative
TeamBrain fixture at `http://127.0.0.1:37865/`. The fixture uses an authenticated
local mock of the cloud contract; these checks did not join a real team, change
sharing, or create a checkout.

- The initial My Work view retains five personal requests, with one request in
  each of In progress, Needs you, Ready to check, Checked, and Other states.
- Selecting TeamBrain displays two shared lists and two open tasks, the example
  team's three-of-five seat count, and the explicit statement that sharing from
  this computer is off. Returning to My Work preserves its separate five-request
  data and counts.
- Expanding a shared task and its nested collision finding reveals the recorded
  next action and explanation. Shared work does not expose the personal review
  mutation controls.
- Loading `/#teambrain` directly selects and loads the shared workspace.
- At an actual `window.innerWidth` of 320 CSS px, the document scroll width is
  also 320 px. The brand, workspace navigation, membership controls, cards, and
  expanded task remain readable without horizontal page overflow. The temporary
  browser viewport override was reset after verification.
- Code review identified one sharing-scope presentation issue: an empty project
  array must mean no projects selected, while only `null` means all projects.
  That distinction was corrected and covered by a regression before final QA.

An independent run of the shared client, TeamBrain route, and viewer header
suites passed all 38 tests. The implementation owner additionally reported the
final build, typecheck, and all 134 targeted tests passing. No remaining blocking
issue was found in the reviewed contract, privacy separation, request races, or
browser behavior.
