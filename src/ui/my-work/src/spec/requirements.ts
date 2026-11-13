// Every requirement in .scratch/work-state-spec/SPEC.md, numbered by spec section.
// kind "ui" must be tagged on at least one wireframe element (npm run coverage checks).
// kind "backend" and "process" are not screens; `wireframe` says how the wireframe reflects them, if at all.
// kind "retired" keeps a replaced requirement's id, with a note saying what replaced it and when. Ids are never reused.

export type RequirementKind = 'ui' | 'backend' | 'process' | 'retired'

export interface Requirement {
  id: string
  section: string
  kind: RequirementKind
  text: string
  wireframe?: string
}

export const REQUIREMENTS: Requirement[] = [
  // 1. The problem it solves
  { id: 'R1.1', section: '1', kind: 'ui', text: 'Human layer at a glance: what I asked for, who is on it, where it stands, what is next, what came out of it.' },

  // 2. The unit is a human request
  { id: 'R2.1', section: '2', kind: 'ui', text: 'Every line is a human-understandable request; everything under it discloses more as you go deeper.' },
  { id: 'R2.2', section: '2', kind: 'ui', text: 'Requests come from my prompts; prompts that are not requests live underneath as work for one.' },
  { id: 'R2.3', section: '2', kind: 'backend', text: 'The tracker decides whether a new prompt is a new request or belongs to an open one.', wireframe: 'Request detail shows prompts the tracker attached to the request.' },
  { id: 'R2.4', section: '2', kind: 'backend', text: 'The tracker owns the human-facing display text.' },
  { id: 'R2.5', section: '2', kind: 'ui', text: 'One request survives /clear, tool switches and days: it groups every conversation that served it.' },
  { id: 'R2.6', section: '2', kind: 'ui', text: 'Human titles: no jargon, short, not 1:1 with granular records.' },
  { id: 'R2.7', section: '2', kind: 'process', text: 'Title generation cost is visible.', wireframe: 'Owner dropped generation-cost display on Oct 20, 2026: the spend is tiny next to the value. Not shown in the GUI.' },

  // 3. Layers and progressive disclosure
  { id: 'R3.1', section: '3', kind: 'retired', text: 'Retired 2026-10-27 (My Focus): the layer order is now focus areas (with Other), then requests, then request detail, then granular records. Replaced by R16.1 and R16.2.' },
  { id: 'R3.2', section: '3', kind: 'ui', text: 'Overall request: progress meter, dates, completion and the build story behind it.' },
  { id: 'R3.3', section: '3', kind: 'ui', text: 'My Work is the live inbox of requests.' },
  { id: 'R3.4', section: '3', kind: 'ui', text: 'Request detail has sub-cards for the workstreams under one request.' },
  { id: 'R3.5', section: '3', kind: 'ui', text: 'Granular records are a small truncated list of work-state updates and observations together, secondary, rolling in live.' },
  { id: 'R3.6', section: '3', kind: 'ui', text: 'Detail pages stay simple.' },
  { id: 'R3.7', section: '3', kind: 'retired', text: 'Retired 2026-10-27 (My Focus): the goals page is gone; focus areas sit in the MY FOCUS rail above the pages. Replaced by R16.1.' },

  // 4. Views
  { id: 'R4.1', section: '4', kind: 'ui', text: 'Cards view: portrait request cards. Since 2026-11-13 they are a view of one focus’s threads beside Threads and Board (R19.10), in sections for what needs a person, what is being worked on, Idle and Done. A card says its status in the same words as a thread row, its next step (the agent’s question while it waits for an answer), its deliverables, progress, stage and times, links to its chat, and opens the request.' },
  { id: 'R4.2', section: '4', kind: 'retired', text: 'Retired 2026-11-11 (thread list): the sortable table is gone; rows keep one order, what waits on a person first, under their focus areas. Replaced by R19.1.' },
  { id: 'R4.3', section: '4', kind: 'ui', text: 'By agent view: a card per agent with its icon and what it is working on, an outer view to the list.' },
  { id: 'R4.4', section: '4, 15.2', kind: 'ui', text: 'Each status is a line of split-flap tiles, as wide as its label, that flips when the status changes, like a train departures board. Since 2026-11-13 it is the Status column of a thread row, after the request: the words of the one status table (Working, Idle, Checked, Closed, Shipped, or Needs you with what is owed on a second line) in the state’s colours, and a shipped request that still owes a move wears that move’s colours. On a phone it sits under the title.' },
  { id: 'R4.5', section: '4', kind: 'retired', text: 'Retired 2026-10-27 (My Focus): the month-by-month report moved to Past focus. Replaced by R16.7.' },
  { id: 'R4.6', section: '4', kind: 'ui', text: 'My Rules page: how I like to work, as if-then blocks.' },

  // 5. What each request shows
  { id: 'R5.1', section: '5', kind: 'ui', text: 'Icon of the agent doing the work.' },
  { id: 'R5.2', section: '5', kind: 'ui', text: 'Who asked (essential in team mode).' },
  { id: 'R5.3', section: '5', kind: 'ui', text: 'When it started.' },
  { id: 'R5.4', section: '5', kind: 'ui', text: 'How long it has been going.' },
  { id: 'R5.5', section: '5', kind: 'ui', text: 'What stage it is in.' },
  { id: 'R5.6', section: '5, 15.3', kind: 'ui', text: 'Ship estimate, only from measured pace ("at this pace, about Oct 24"), otherwise empty.' },
  { id: 'R5.7', section: '5, 15.4', kind: 'ui', text: 'After ship: Shipped state with follow-ups tagged Docs, Promo or Other; open follow-ups stay visible.' },
  { id: 'R5.8', section: '5', kind: 'ui', text: "What's next, and whose move: bot icon or human icon." },
  { id: 'R5.9', section: '5', kind: 'ui', text: 'Progress meter on the card, with completion and dates.' },
  { id: 'R5.10', section: '5', kind: 'ui', text: 'Work product attached as links (decks, PRs, pages), viewable from the request and goals.' },
  { id: 'R5.11', section: '5', kind: 'ui', text: 'Progress comes from a memory review, not guesses, and shows its evidence.' },
  { id: 'R5.12', section: '5', kind: 'ui', text: 'Deliverables (decks, reports, pages, files the agent made) are linked on the front of the card, one click to open; claude-mem keeps a copy in the project bucket.' },

  // 6. Live behavior
  { id: 'R6.1', section: '6', kind: 'ui', text: 'Runs live off work-state updates.' },
  { id: 'R6.2', section: '6', kind: 'ui', text: "States you can tell apart at a glance: working, done but not yet checked, and so on." },
  { id: 'R6.3', section: '6', kind: 'ui', text: 'Space for people to pick up work.' },
  { id: 'R6.4', section: '6', kind: 'ui', text: 'A real indicator of what is live and what is not.' },

  // 7. Performance, story and self-learning
  { id: 'R7.1', section: '7', kind: 'ui', text: 'Performance and shipping velocity, in human terms, not a raw index.' },
  { id: 'R7.2', section: '7', kind: 'ui', text: 'A real narrative of the build story.' },
  { id: 'R7.3', section: '7', kind: 'ui', text: 'Preferences extracted for how I like to work feed self-learning (My Rules).' },
  { id: 'R7.4', section: '7', kind: 'retired', text: 'Retired 2026-11-11 (thread list): the recap panel with its hero image left My Work; the build story opens from one link.' },

  // 8. Where it lives
  { id: 'R8.1', section: '8', kind: 'ui', text: 'Replaces the localhost:377** viewer; fully local and live.' },
  { id: 'R8.2', section: '8', kind: 'retired', text: 'Retired 2026-11-11 (thread list): the Connect Claude.ai / Connect ChatGPT prompts lived in the recap panel, which left My Work.' },
  { id: 'R8.3', section: '8', kind: 'process', text: 'Ships as the flagship claude-mem 14.0.0+ open-source release.' },
  { id: 'R8.4', section: '8', kind: 'backend', text: 'PostHog telemetry on how agents adhere to work state.' },

  // 9. TeamBrain
  { id: 'R9.1', section: '9', kind: 'ui', text: 'TeamBrain is a natural extension of the same GUI, not a separate app.' },
  { id: 'R9.2', section: '9', kind: 'ui', text: 'Team work-state board: work collisions, roles, delegation, everyone in sync.' },
  { id: 'R9.3', section: '9', kind: 'ui', text: '"Who asked" is essential in team mode.' },
  { id: 'R9.4', section: '9', kind: 'ui', text: 'Self-serve PLG: buy the team plan from inside the product.' },
  { id: 'R9.5', section: '9', kind: 'process', text: 'Quality bar: no "colorful mess"; real design attention.', wireframe: 'Grayscale wireframe; color decisions belong to the mockup pass.' },

  // 10. Look and feel
  { id: 'R10.1', section: '10', kind: 'process', text: 'Clarity like Basecamp and Patreon; AI SDK Agents patterns as reference.', wireframe: 'AI Elements and the AI SDK Agents patterns are a design reference, not a required kit; Aceternity components sit alongside them.' },
  { id: 'R10.2', section: '10', kind: 'ui', text: 'Subtle drop shadows that give surfaces texture, not one on everything; nothing harsh.' },
  { id: 'R10.3', section: '10', kind: 'ui', text: 'React on a real UI kit, not plain HTML.' },
  { id: 'R10.4', section: '10', kind: 'ui', text: 'Agent icons on their work; the cmem brain mark is the only logo.' },
  { id: 'R10.5', section: '10', kind: 'ui', text: 'Clean, uncluttered text.' },

  // 11. Design state and process
  { id: 'R11.1', section: '11', kind: 'ui', text: 'Mobile designed for human eyes and thumbs.' },
  { id: 'R11.2', section: '11', kind: 'process', text: 'Visual design goes through image mockups with the UI Redesign skill, run by Codex.', wireframe: 'Superseded on Oct 26, 2026: the owner asked for Aceternity components built straight into the React app, any of them, skeuomorphic included.' },

  // 12. Truth rules
  { id: 'R12.1', section: '12', kind: 'ui', text: 'Real data only, never simulated; empty states instead of invented numbers.' },
  { id: 'R12.2', section: '12', kind: 'ui', text: 'Show what a person needs to decide, not raw counts.' },
  { id: 'R12.3', section: '12', kind: 'ui', text: 'Lead with what matters to the reader.' },

  // 13. Home and on the go
  { id: 'R13.1', section: '13', kind: 'ui', text: 'The same UI runs at home (localhost) and on the go (cmem.ai).' },
  { id: 'R13.2', section: '13', kind: 'ui', text: "Other machines' agents show alongside local ones, already synced." },
  { id: 'R13.3', section: '13.1', kind: 'backend', text: 'Replay rows in write order, then source device and row.' },
  { id: 'R13.4', section: '13.2', kind: 'ui', text: 'Say which agent and machine did the work; device name when the agent is unknown.' },
  { id: 'R13.5', section: '13.3', kind: 'backend', text: 'Groupings, titles, goals runs and rules sync as append-only records.' },
  { id: 'R13.6', section: '13.4', kind: 'backend', text: 'Turn work-state sync on, accounting for clients before 13.29.' },
  { id: 'R13.7', section: '13.5', kind: 'ui', text: 'Changes made on the web are written from a "web" device and pulled down by every machine.' },
  { id: 'R13.8', section: '13.6', kind: 'ui', text: 'Freshness for each machine ("MacBook, synced 4 min ago").' },

  // 14. My Rules
  { id: 'R14.1', section: '14', kind: 'retired', text: 'Retired 2026-10-27 (My Focus): the nav is MY FOCUS (areas, Other, Suggested), then My Work, then My Rules. Replaced by R16.1.' },
  { id: 'R14.2', section: '14', kind: 'ui', text: 'Learned rules not yet approved sit in a Suggested group under each scope.' },
  { id: 'R14.3', section: '14', kind: 'ui', text: 'Rule block: When, Then, Why (dated quotes), Strength, Status.' },
  { id: 'R14.4', section: '14', kind: 'ui', text: 'Replaced rules stay visible, marked with the rule and date that replaced them.' },
  { id: 'R14.5', section: '14', kind: 'ui', text: 'Grouped by scope: everywhere, then per product or project, then per situation.' },
  { id: 'R14.6', section: '14', kind: 'ui', text: 'Within a scope, rules the owner wrote or approved come first, grouped apart from learned ones.' },
  { id: 'R14.7', section: '14', kind: 'ui', text: 'Then sorted by strength (times seen × recency); newer wins a conflict.' },
  { id: 'R14.8', section: '14', kind: 'ui', text: 'Rules merge request-progress preferences and owner-goals "how they want work done"; source is shown.' },
  { id: 'R14.9', section: '14', kind: 'ui', text: 'Owner can approve, edit, turn off or add a rule.' },
  { id: 'R14.10', section: '14', kind: 'ui', text: 'Refresh buttons on My Goals and My Rules: last run time, machine, progress and cost.', wireframe: 'Cost part dropped by the owner on Oct 20, 2026; last run time, machine and progress stay.' },
  { id: 'R14.11', section: '14', kind: 'ui', text: 'On the web, Refresh queues a run for the next online machine.' },
  { id: 'R14.12', section: '14', kind: 'ui', text: 'request-progress gets a Refresh button too.' },
  { id: 'R14.13', section: '14', kind: 'ui', text: 'At home, Refresh runs on the local worker, which reads the Claude Code and Codex transcripts; the web cannot.' },
  { id: 'R14.14', section: '14', kind: 'ui', text: 'Strength reads in human terms: times seen, latest date, and whether the owner set it or it was learned.' },

  // 15. Decisions
  { id: 'D1', section: '15.1', kind: 'retired', text: 'Retired 2026-10-27 (My Focus): the combined-progress rule (reviewed requests only) now applies to the area header, and the card chip names the area, Other, or Sorting…. Replaced by R16.2 and R16.5.' },
  { id: 'D5', section: '15.5', kind: 'ui', text: 'Agent-only card shows terminal lines, a corner spinner with a one-word hover, then transforms to human text (any transform effect); static under reduced motion. In the thread rows an untitled request is a row that says its title is being written (R19.1).' },
  { id: 'D6', section: '15.6', kind: 'process', text: 'Each Refresh shows its last run cost; My Rules shows the week’s title cost.', wireframe: 'Owner dropped generation-cost display on Oct 20, 2026: the spend is tiny next to the value. Not shown in the GUI.' },
  { id: 'D7', section: '15.7', kind: 'ui', text: 'Approved rules are written to ~/.claude-mem/MY-RULES.md and loaded with user-level instructions; never project files; approved only.' },

  // Added with the My Goals pass (append only)
  { id: 'R3.8', section: '3', kind: 'retired', text: 'Retired 2026-10-27 (My Focus): mined focus areas become suggested areas, and asks show as Not started rows under their area, each with dated quotes. Replaced by R16.2 and R16.4.' },
  { id: 'R3.9', section: '3', kind: 'retired', text: 'Retired 2026-10-27 (My Focus): request progress rolls up into its focus area header; goals are one sentence on an area. Replaced by R16.2.' },

  // 16. My Focus (added 2026-10-27, append only): focus areas are the top level of My Work.
  { id: 'R16.1', section: '16', kind: 'retired', text: 'Retired 2026-11-11 (focus-first board): the MY FOCUS rail and the phone chip row are gone; the focus list is the page itself and the other pages are links in the header. Replaced by R19.9 and R19.11.' },
  { id: 'R16.2', section: '16', kind: 'ui', text: 'The area header: its goal sentence, combined progress of its reviewed requests (unreviewed ones named, not counted), what shipped, asks with no work yet as Not started rows with how often I asked and my quotes, and a menu to Rename, Edit goal, Merge into…, reorder and mark Done.' },
  { id: 'R16.3', section: '16', kind: 'ui', text: 'Other is a permanent bucket for requests that fit no area, with its own header; it is never an area.' },
  { id: 'R16.4', section: '16', kind: 'ui', text: 'Suggested areas wait in a decision queue with Keep, Rename, Merge and Dismiss; each decision can be undone, and a refresh never overrides it.' },
  { id: 'R16.5', section: '16', kind: 'ui', text: 'Each request shows its area chip: the area\'s name, Other, or "Sorting…" until a refresh places it.' },
  { id: 'R16.6', section: '16', kind: 'ui', text: 'Move to focus on a request puts it in another area or Other; my move wins over any later automatic placement. It is on the request page and on every thread row: always showing on rows under Other and Sorting, where filing is the one useful action, and on hover or keyboard focus on rows inside a focus. It lists the kept focuses in my order, then the suggested ones, then Other, with the current place marked, and the move can be undone from the saved note.' },
  { id: 'R16.7', section: '16', kind: 'ui', text: 'Past focus, linked from the header, holds areas marked done and what I asked for most, month by month.' },

  // 17. Shared focus page (added 2026-10-29, append only): share a focus area as a page people and agents comment on.
  { id: 'R17.1', section: '17', kind: 'ui', text: 'Share a focus area as a page by link (cmem.ai/focus/…), from the area menu; the area shows that it is shared.' },
  { id: 'R17.2', section: '17', kind: 'ui', text: 'People and agents can comment on the shared page; the owner reads and answers the comments from My Work.' },
  { id: 'R17.3', section: '17', kind: 'ui', text: 'When shared, it keeps updating and adding what belongs to the area, but nothing new and unrelated that the people it is shared with would not want to see (situational awareness): only requests placed in that area, never other areas or Other.' },
  { id: 'R17.4', section: '17', kind: 'ui', text: 'Stop sharing at any time; the link stops working for everyone, and sharing again makes a new link.' },
  { id: 'R17.5', section: '17', kind: 'backend', text: 'The shared page carries display text only: no prompts, quotes, transcripts, evidence links, files or machine names.', wireframe: 'to-shared-focus.ts builds the page; cmem.ai keeps only the shared shape (claude-mem-pro src/lib/focus-share/snapshot.ts).' },

  // 18. Account (added 2026-11-05, append only): the cloud viewer is where viewer accounts land, so billing is reachable from it.
  { id: 'R18.1', section: '18', kind: 'ui', text: 'On the cloud viewer only, the header links "Account & billing" to cmem.ai/account. My Work served from this computer shows no such link.' },

  // 19. Thread list (added 2026-11-11, append only): My Work reads as a plain list of threads, not cards.
  { id: 'R19.1', section: '19', kind: 'ui', text: 'My Work is a vertical list of threads, one plain row per request with hairline dividers, under one-line focus area headings (name and count) in priority order, then Other, then not sorted yet. Inside one area there are no headings. What waits on a person comes first, newest first. A focus’s rows sit in one bordered panel with a header line of column names and a quiet hover, the look of the List view before it; no header sorts.' },
  { id: 'R19.2', section: '19', kind: 'ui', text: 'Each thread links to its chat: the transcript opens in a new tab, and where the tool has a documented resume command (Claude Code) it can be copied. No link or command is invented.' },
  { id: 'R19.3', section: '19', kind: 'ui', text: 'Each thread always shows its next step and who it waits on: the agent by name, or a person with what it needs from them (answer, review or approval). In team mode a move on a request someone else asked for names that person. A checked or closed thread has no next step and waits on nobody: its cell says only when it was checked.' },
  { id: 'R19.4', section: '19', kind: 'ui', text: 'A person makes their move from the row: Mark checked for a review, Join or Not this for a grouping approval, otherwise Open chat. Nothing pretends to deliver a reply into an agent session.' },
  { id: 'R19.5', section: '19', kind: 'ui', text: 'Each thread carries its risk from the last memory review as the dot that leads its row: green, amber or red, and a hollow muted ring for a request no review rated, never a guessed level. Hover, keyboard focus and a screen reader get the level in words with the review’s reason. Nothing else on the row is coloured by risk: no row is tinted. The row’s status is said in words in its own column (R4.4).' },
  { id: 'R19.6', section: '19', kind: 'ui', text: 'Request, status, next step and why sit in aligned columns that wrap (in a wide window; narrower, a row stacks), under the focus area, so each thread reads as what was asked, what happens next and which goal or principle of the owner it serves. The why never restates the request, and is empty until a review records one.' },
  { id: 'R19.7', section: '19', kind: 'ui', text: 'Stage: a thread waiting for review says in its own column what there is to look at, and never names something that was not made. A ready stage is named by its format and opens in the stage reader. A stage being made says so; a failed one says why and can be made again. With no stage yet, a quiet Generate action starts one run of the default format from the row (one click, one run), beside the review’s first deliverable and its screenshots when it has them; other formats are on the request page.' },
  { id: 'R19.8', section: '19', kind: 'ui', text: 'A thread waiting for an answer shows the question, takes the answer on the row, and holds what the person may need to know to answer it one click away.' },
  { id: 'R19.9', section: '19', kind: 'ui', text: 'The first view is the focus list in the order the owner set, across the whole page: each focus is one line with its name (the goal is its hover text) and how many chats it holds in each open state plus one quiet count of everything that rests in Done, opens onto its threads in place, and is moved by its grip.' },
  { id: 'R19.10', section: '19', kind: 'ui', text: 'Board and Cards are further views of one focus’s threads, never of every request at once: inside an opened focus line and on a focus page, a small Threads / Board / Cards switch (one choice for every focus, remembered per viewer; a saved value this version does not know reads as Threads) shows that focus’s threads as rows, as request cards (R4.1), or as columns for what a person must do next (Answer, Review, Approve), then Working, Idle and Done. Every request is in exactly one column; shipped, checked and closed requests rest together under Done. A card shows the risk dot (its column names its status), the title, the next step and the chat link, with no tint. Idle and Done show their newest five until asked for all. Nothing drags. A preference saved for the old board over everything reads as the focus list with the board inside each focus.' },
  { id: 'R19.11', section: '19', kind: 'ui', text: 'With no side panel, the header carries plain text links to My Focus, My Rules, Suggested (while areas wait for a decision), Past focus and, on the cloud viewer, Account & billing. On phones and narrow windows the same links sit on one line above the page.' },
  { id: 'R19.12', section: '19', kind: 'ui', text: 'Send hands the answer to the request’s own agent session, and the row says how that went: sending, delivered, or not delivered with the reason. A delivery on its way or failed is said on the row and on the request page whether or not the agent still asks, and a failed one keeps the answer to copy, with a link to the chat. A session it cannot be sent to says why, and the answer is copied with a link to the chat.' },
  { id: 'R19.13', section: '19', kind: 'ui', text: 'The request lists every stage format with where its stage stands (being made, ready, failed with the reason). A ready stage opens; a format with no stage, or a failed one, has Generate, and one click is one run.' },
  { id: 'R19.14', section: '19', kind: 'ui', text: 'Staging every finished review automatically is off until the owner picks a format for it, and says it runs the agent once per finished review.' },
  { id: 'R19.15', section: '19', kind: 'ui', text: 'A focus carries the owner’s notes on why it matters, on the opened focus line and the focus page: plain text, edited in place (2,000 characters), saved with Undo. A focus with no notes shows only a quiet button to add them.' },
  { id: 'R19.16', section: '19', kind: 'ui', text: 'Planning help for all focuses or one: a button starts it and says where it stands. A ready plan lists its suggestions by kind (the order, projects to file focuses under, goals, notes, next asks) with their reasoning; Accept saves one as the owner’s own focus change, Dismiss hides it, a next ask is copied, and nothing is applied without a click.' },
  { id: 'R19.17', section: '19', kind: 'ui', text: 'A focus can carry the owner’s own icon. Every focus line keeps the icon’s place before the name: it shows the icon, or nothing at rest and a quiet outline when the line is pointed at or holds the keyboard. Clicking it opens a menu right there: Upload image, Generate (the owner’s agent draws one: one click, one run), Generate with prompt… (one line of the owner’s direction for what to draw, at most 300 characters) and, with an icon, Remove icon. A run shows as a spinner in the icon’s place, and a failure says its reason under the line. The agent is shown the owner’s other icons and draws one that differs from them. A focus page shows the same menu. No icon is ever chosen or generated without the owner asking.' },
  { id: 'R19.18', section: '19', kind: 'ui', text: 'Every focus line the list shows for a kept or suggested focus has a grip at its start (Other and Sorting have none), and a suggested focus says so in one quiet word. The grip drags the line to another place among the focuses. The list shows the new order at once, one save writes the whole order, and a refused save puts the lines back and says why. Moving a suggested focus keeps it and places it where it was dropped, as one change with one Undo that hands it back as a suggestion. From the keyboard the grip takes the focus, Arrow Up or Arrow Down moves the line one place the same way, and the new place is announced. On a touch screen the grip always shows.' },
  { id: 'R19.19', section: '19', kind: 'ui', text: 'The focus list is arranged by Priority (the owner’s order) or by Project, remembered per viewer. A project is the owner’s own heading for several focuses. A focus sits under the project the owner filed it under; until then under a guess (the folder most of its requests ran in), whose heading says it is a guess; with neither, or once the owner files it under No project (which no guess replaces), last under No project. Headings come in the order of their best-ranked focus and show their focus count. Clicking a heading renames it in place (Enter saves, Escape cancels): every focus under it is filed under the new name in one change, and a name another heading has merges the two. A project is also merged into another directly: by dragging its heading’s grip onto the other project, which highlights, or from the heading’s menu (Merge into), with no drag. Every focus of the first is filed under the second in one change, and the saved note says which was merged into which. A focus, kept or suggested, is filed under another heading by dragging its grip there, or from its Move to project menu, which also names a new project or files it under No project. Names match whatever their case. Inside a heading, the grip reorders as by priority and every other focus keeps its place. Each change can be undone from the saved note, and a refresh never replaces the owner’s filing.' },
  { id: 'R19.20', section: '19', kind: 'ui', text: 'Every thread is one key away: Cmd+K (Ctrl+K off a Mac) or the header’s search button opens a search over the loaded requests from any page, matching the title, next step, why, focus name and the focus’s project in any word order, title matches first, then what waits on the owner. Enter, or a click on the row, shows the thread on the board; Cmd or Ctrl with Enter, or the control at the end of the row, opens the thread’s chat in its own app through its link, and shows a thread with no chat link on the board. Nothing typed lists the open threads, what needs the owner first; a thread that rests in Done is found by typing.' },
  { id: 'R19.21', section: '19', kind: 'ui', text: 'Finished work is out of the way until asked for. A request the owner marked checked owes nothing: it leaves Needs you and rests in Done with shipped requests and closed ones (every item dropped, or the latest chat archived in its tool), each keeping its own label. The list opens on Open work, which leaves Done out; the Done filter shows only those. A focus whose requests are all Done keeps its line. On the board the Done column is a header with its count until the person opens it, and stays as they left it.' },
  { id: 'R19.22', section: '19', kind: 'ui', text: 'Every dot says what it stands for on hover, on keyboard focus and to a screen reader: a thread\'s dot says its risk (R19.5), a focus line\'s count dot says the count in words ("3 need you"), and a search result\'s dot what it needs from a person ("Needs you · review") or where it stands (Working, Idle, Checked, Closed, Shipped). A thread row says those same status words in its Status column.' },
  { id: 'R19.23', section: '19', kind: 'ui', text: 'A ready stage is read inside the page: from the row or the request page it opens as a document in a dialog titled with the request and the format, scrolling inside, closed with Escape. Markdown is laid out as headings, lists, tables, code, quotes, links (opened in a new tab) and the evidence images the worker placed; raw HTML in it is shown as text, a link is followed only to http, https or the page’s own origin, and an image is loaded only from the page’s own origin. A stage that is an HTML page (a deck) runs in a sandboxed frame that shares nothing with the page. Under the document are a link to the raw file, the chat link and Mark checked. While the file loads, and when it cannot be read, the dialog says so in words.' },
  { id: 'R19.24', section: '19', kind: 'ui', text: 'Every thread shows how long ago it was asked, in a few quiet characters at the end of its row, on its board card and in the search results: now under a minute, then minutes (5m), hours (3h), days (2d), weeks from 14 days (2w) and months from two months (3mo). Hover or keyboard focus says it in words with the date and time, a screen reader hears the words, and the ages move together while the page is open. A request whose start was not recorded shows no age.' },
  { id: 'R19.25', section: '19', kind: 'ui', text: 'The top of My Focus is the focuses as Threads or as Cards, remembered per viewer; a saved value this version does not know reads as Threads, a Cards view saved before the thread list is still Cards, and a saved List reads as Threads. Threads is the focus list (R19.9). Cards is one card per focus in the owner’s order (the first four, then all on request, then the suggested ones): its name and goal, how many requests need the owner and how many are being worked on, the next step that opens its request, its work and evidence, and a button that opens the focus. A card’s only picture is the focus’s own icon (R19.17); a focus without one has no picture and no empty frame, and no stock artwork is shown. The filters apply to both, so Done is left out of a card’s counts until asked for. Priority / Project arranges Threads only. With one focus open this switch is not shown; that focus has its own (R19.10).' },
]

export const REQUIREMENTS_BY_ID = new Map(REQUIREMENTS.map((requirement) => [requirement.id, requirement]))
