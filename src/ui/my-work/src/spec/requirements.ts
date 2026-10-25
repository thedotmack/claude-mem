// Every requirement in .scratch/work-state-spec/SPEC.md, numbered by spec section.
// kind "ui" must be tagged on at least one wireframe element (npm run coverage checks).
// kind "backend" and "process" are not screens; `wireframe` says how the wireframe reflects them, if at all.

export type RequirementKind = 'ui' | 'backend' | 'process'

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
  { id: 'R3.1', section: '3', kind: 'ui', text: 'Layer order: My Goals, then overall requests, then My Work cards, then request detail, then granular records.' },
  { id: 'R3.2', section: '3', kind: 'ui', text: 'Overall request: progress meter, dates, completion and the build story behind it.' },
  { id: 'R3.3', section: '3', kind: 'ui', text: 'My Work is the live inbox of request cards.' },
  { id: 'R3.4', section: '3', kind: 'ui', text: 'Request detail has sub-cards for the workstreams under one request.' },
  { id: 'R3.5', section: '3', kind: 'ui', text: 'Granular records are a small truncated list of work-state updates and observations together, secondary, rolling in live.' },
  { id: 'R3.6', section: '3', kind: 'ui', text: 'Detail pages stay simple.' },
  { id: 'R3.7', section: '3', kind: 'ui', text: 'Goals is its own page up top, not inside My Work.' },

  // 4. Views
  { id: 'R4.1', section: '4', kind: 'ui', text: 'Cards view: portrait request cards.' },
  { id: 'R4.2', section: '4', kind: 'ui', text: 'List view with sorting.' },
  { id: 'R4.3', section: '4', kind: 'ui', text: 'By agent view: a card per agent with its icon and what it is working on, an outer view to the list.' },
  { id: 'R4.4', section: '4, 15.2', kind: 'ui', text: 'Status board merged into List: a status column whose label flips when it changes.' },
  { id: 'R4.5', section: '4', kind: 'ui', text: 'My Goals shows the owner-goals report, month by month.' },
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

  // 6. Live behavior
  { id: 'R6.1', section: '6', kind: 'ui', text: 'Runs live off work-state updates.' },
  { id: 'R6.2', section: '6', kind: 'ui', text: "States you can tell apart at a glance: working, done but not yet checked, and so on." },
  { id: 'R6.3', section: '6', kind: 'ui', text: 'Space for people to pick up work.' },
  { id: 'R6.4', section: '6', kind: 'ui', text: 'A real indicator of what is live and what is not.' },

  // 7. Performance, story and self-learning
  { id: 'R7.1', section: '7', kind: 'ui', text: 'Performance and shipping velocity, in human terms, not a raw index.' },
  { id: 'R7.2', section: '7', kind: 'ui', text: 'A real narrative of the build story.' },
  { id: 'R7.3', section: '7', kind: 'ui', text: 'Preferences extracted for how I like to work feed self-learning (My Rules).' },
  { id: 'R7.4', section: '7', kind: 'ui', text: 'Daily recap with milestone images or one hero image.' },

  // 8. Where it lives
  { id: 'R8.1', section: '8', kind: 'ui', text: 'Replaces the localhost:377** viewer; fully local and live.' },
  { id: 'R8.2', section: '8', kind: 'ui', text: 'Connect Claude.ai / Connect ChatGPT CTAs as the cloud sync funnel entry point.' },
  { id: 'R8.3', section: '8', kind: 'process', text: 'Ships as the flagship claude-mem 14.0.0+ open-source release.' },
  { id: 'R8.4', section: '8', kind: 'backend', text: 'PostHog telemetry on how agents adhere to work state.' },

  // 9. TeamBrain
  { id: 'R9.1', section: '9', kind: 'ui', text: 'TeamBrain is a natural extension of the same GUI, not a separate app.' },
  { id: 'R9.2', section: '9', kind: 'ui', text: 'Team work-state board: work collisions, roles, delegation, everyone in sync.' },
  { id: 'R9.3', section: '9', kind: 'ui', text: '"Who asked" is essential in team mode.' },
  { id: 'R9.4', section: '9', kind: 'ui', text: 'Self-serve PLG: buy the team plan from inside the product.' },
  { id: 'R9.5', section: '9', kind: 'process', text: 'Quality bar: no "colorful mess"; real design attention.', wireframe: 'Grayscale wireframe; color decisions belong to the mockup pass.' },

  // 10. Look and feel
  { id: 'R10.1', section: '10', kind: 'process', text: 'Clarity like Basecamp and Patreon; AI SDK Agents patterns as reference.', wireframe: 'Built from AI Elements, the AI SDK component set.' },
  { id: 'R10.2', section: '10', kind: 'ui', text: 'Subtle: no drop shadows everywhere, nothing harsh.' },
  { id: 'R10.3', section: '10', kind: 'ui', text: 'React on a real UI kit, not plain HTML.' },
  { id: 'R10.4', section: '10', kind: 'ui', text: 'Agent icons on their work; the cmem brain mark is the only logo.' },
  { id: 'R10.5', section: '10', kind: 'ui', text: 'Clean, uncluttered text.' },

  // 11. Design state and process
  { id: 'R11.1', section: '11', kind: 'ui', text: 'Mobile designed for human eyes and thumbs.' },
  { id: 'R11.2', section: '11', kind: 'process', text: 'Visual design goes through image mockups with the UI Redesign skill, run by Codex.', wireframe: 'This wireframe fixes structure only; visuals come from the mockup pass.' },

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
  { id: 'R14.1', section: '14', kind: 'ui', text: 'Top nav: My Work – My Goals – My Rules.' },
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
  { id: 'D1', section: '15.1', kind: 'ui', text: 'Goals show the progress meters of the requests serving them, combined; each card has a goal chip; "No goal" when it serves none.' },
  { id: 'D5', section: '15.5', kind: 'ui', text: 'Agent-only card shows terminal lines, a corner spinner with a one-word hover, then transforms to human text; static under reduced motion.' },
  { id: 'D6', section: '15.6', kind: 'process', text: 'Each Refresh shows its last run cost; My Rules shows the week’s title cost.', wireframe: 'Owner dropped generation-cost display on Oct 20, 2026: the spend is tiny next to the value. Not shown in the GUI.' },
  { id: 'D7', section: '15.7', kind: 'ui', text: 'Approved rules are written to ~/.claude-mem/MY-RULES.md and loaded with user-level instructions; never project files; approved only.' },

  // Added with the My Goals pass (append only)
  { id: 'R3.8', section: '3', kind: 'ui', text: 'My Goals holds top priorities and open asks mined from my own prompts, each with my dated quotes.' },
  { id: 'R3.9', section: '3', kind: 'ui', text: 'Request progress reads as a natural extension of goals, not a separate top level.' },
]

export const REQUIREMENTS_BY_ID = new Map(REQUIREMENTS.map((requirement) => [requirement.id, requirement]))
