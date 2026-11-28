# Focus areas in onboarding and My Work

Focus areas organize work around what a person is trying to achieve. The same recorded areas should appear during onboarding and in the live work view: the payoff is recognizing your own work and opening something useful immediately.

## Information and actions

The hierarchy is **Focus Area → Sub focus → Request → Detail**. Each area has a one-sentence goal; each request has one area or Other. Repositories describe where work happened, rather than defining its top-level grouping. Owner ordering and explicit keep, rename, move and dismiss decisions take precedence over later suggestions.

Reveal areas as their saved records arrive. Missing extraction results remain loading until the run ends; a finished empty result stays empty. Membership comes from recorded area IDs, never a title guess. Show real next actions and source evidence, and retain the existing request view when an area opens.

Artwork makes areas recognizable. It should not obscure plain request cards, where the important questions remain: what is this, does it need me, and where is the result? One dominant action follows the current need. Recorded completion, an accessible output and verified delivery are distinct facts.

## Sub focuses

A sub focus is a named group of related requests inside one focus area: the subject the owner would look for when an area holds more than they can scan. A request sits in at most one sub focus of its area. The goal and the priority stay on the area. Other has no sub focuses.

- A sub focus holds at least two requests. A group of one is not a group, so the check that saves a model's answer leaves that request ungrouped. When a sub focus drops below two (the owner moves a request out, or one leaves the area), the next pass over the area decides its remaining request again.
- A request the model cannot place with others stays ungrouped. The area page lists it under "More in <area>".
- An area shows sub focus cards only when it has at least two sub focuses that each hold at least two requests. A sub focus with fewer is not shown as a card, and its request is listed under "More in <area>". Otherwise the area opens straight to its list of requests. A screen counts a sub focus's requests the way it counts an area's: the served requests whose `subFocusId` names it.
- So an area is only asked about sub focuses once it holds at least four placed requests: fewer cannot make two groups of two. The pass counts and asks about only the requests the screen shows. A request whose every ask was judged agent-written has no card, so it is never grouped. The question is asked again only when the set of requests placed in the area changes, never for a new review. A pass recorded before passes counted only shown requests covered every request placed in the area, and it still counts as that area's pass until a request is placed in the area or moved out: an upgrade or a rescan alone never asks an area again, whether its last pass was answered or failed. A pass that fails (its answer refused twice, the model call failing, quota or login refusals included) is recorded as failed on that set, never as answered: no scheduled refresh asks the same question again until the set changes, and the owner's Refresh asks it again.
- The model proposes the groups and their names, the check refuses an unknown request or sub focus, a request placed twice and a new group named like an existing sub focus, and the owner corrects: renaming or merging a sub focus, or moving a request into another sub focus of its area or out of every one. A later pass never overrides the owner's edit.
- Sub focuses and their placements are rows in the my-focus list, beside areas and placements, so they sync the same way. Ids are random, never made from the name, so a rename keeps the id. A sub focus has no status: one with no requests is not shown, and a link to it opens its area.
- A placement holds only while the request is in the area it was made in, or in the area that one was merged into. Moving a request to another area leaves it ungrouped there until the next pass. Merging an area takes its sub focuses, with the owner's names and placements, into the area it was merged into, and undoing the merge gives them back.

## Imagery and live behavior

Use real generated concept images or relevant retained work to identify the area. Keep titles, counts and live status in readable UI text outside the image. Concept art does not prove completion and is not a user deliverable.

Use a consistent visual family with distinct subjects. Wide covers suit the overview; compact imagery and an off setting support denser work. The artwork density is a local display preference, defaults to full, and does not initiate generation. Images must have useful fallbacks and remain optional for understanding the work.

Generation should be explicit, cached by stable subject/content version and reused. A route render or live snapshot refresh must never cause a paid generation request. Keep the existing image while a replacement is pending or fails. Live updates change the recorded information, without regenerating subject art or fabricating progress.

## Recovered evidence and design limits

The recovered October focus-area decisions established stable areas, owner-controlled priority, one home per request and goals as sentences rather than another grouping. The Task Atlas imagery investigation established stable subject art with live text and full/compact/off density. Later component studies favored a bounded focus rail, clear current location and plain request cards with one meaningful action.

An older full-screen visual treatment was subsequently rejected; it is a historical reference rather than approved styling. This implementation should follow the current product's shell and preserve useful behavior while making the focus-area payoff visibly distinct.

The exact ChatGPT mockup conversation and the specific AJ/Miles discussions were not recovered from the available connected sources. These requirements combine the current request with recovered design records; no inferred decision is attributed to those discussions. Private source locations and research artifacts remain outside this public design note.

Onboarding screen identity and successful completion semantics follow [the setup funnel contract](../setup-funnel-analytics.md). Changing the reveal content must preserve the existing branch, telemetry-consent and completion rules.
