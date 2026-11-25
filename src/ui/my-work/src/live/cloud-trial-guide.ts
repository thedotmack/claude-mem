export const TRIAL_CONNECT_TASK = 'Use Claude-Mem to find my most recent saved decision or next action. Quote it and show me its source. If I have no synced notes yet, tell me.'

export interface TrialGuideStep {
  day: number
  title: string
  instruction: string
  prompt: string
  writesNote?: boolean
  opensFocus?: boolean
  schedule?: { defaultTime: string; request: string }
}

const MORNING_BRIEF: TrialGuideStep = {
  day: 7, title: 'Get a weekday morning brief',
  instruction: 'Preview tomorrow’s routine now. Paste the prompt into an agent and check that the brief cites your own work.',
  prompt: 'Search my synced Claude-Mem work since the previous weekday morning. In three bullets, show what changed, one decision or blocker that needs me, and my suggested first action. Cite the source for each finding. If there is no recent work, say so.',
  schedule: {
    defaultTime: '09:00',
    request: 'Schedule “Morning work brief” every weekday at {time} in {zone}. If a task with that name already exists, show it to me before changing it. Create only one. Use the following instructions for each run. Confirm the saved task and its next run time. If the scheduled task cannot read Claude-Mem, tell me and leave it unscheduled.',
  },
}

export const TRIAL_GUIDE_STEPS: readonly TrialGuideStep[] = [
  {
    day: 1, title: 'Save a handoff note',
    instruction: 'Leave your next agent a starting point. Use a connected agent that can save notes, then look up the note on another device.',
    prompt: 'Use Claude-Mem to save a note titled “Cloud Sync handoff” with this project’s latest decision and my next action. If you need context, ask which project and action I want to save. Show me the saved note.',
    writesNote: true,
  },
  {
    day: 3, title: 'Pick up on your phone or in another agent',
    instruction: 'Open a second agent on the same Cloud Sync account, on your phone or another computer. Paste the prompt and check the source before picking up the work.',
    prompt: 'Find my latest “Cloud Sync handoff” in Claude-Mem and quote the next action. If there is no handoff note, find my most recent synced project decision or open task instead. Show its source so I can check it. If there are no records, say so.',
  },
  {
    day: 6, title: 'Find out why we made a decision',
    instruction: 'Pick a real decision you want to revisit. Tell your agent the project or topic and compare the answer with the original record.',
    prompt: 'Ask which project and decision I want to revisit, then search Claude-Mem for it. Show the decision, the reason we recorded, and a dated source for each. If a later record changed the decision, show both. Say when a reason is missing.',
  },
  MORNING_BRIEF,
  {
    day: 10, title: 'Review a Focus Area from your phone',
    instruction: 'Open a Focus Area and tap a linked request to see what needs you. If your work is still being grouped, open All requests. You can also ask an agent which blocker to tackle first.',
    prompt: 'Search my recent synced work for an unresolved blocker. Name the project, quote the request or decision that is waiting, and show its source. Suggest one action I can take from my phone. If you cannot verify an open blocker, say so.',
    opensFocus: true,
  },
  {
    day: 14, title: 'Make a Friday project review',
    instruction: 'Try one review before making it a weekly habit. Compare a decision in the recap with its saved source.',
    prompt: 'Review this week’s synced Claude-Mem work by project. List what finished, what is still open, and one next action for next week. Cite dated records. Mark anything without a recorded outcome as open.',
    schedule: {
      defaultTime: '16:00',
      request: 'Schedule “Weekly project review” every Friday at {time} in {zone}. If a task with that name already exists, show it to me before changing it. Create only one. Use the following instructions for each run. Confirm the saved task and its next run time. If the scheduled task cannot read Claude-Mem, tell me and leave it unscheduled.',
    },
  },
]

export const FIRST_TRIAL_ROUTINE_DAY = MORNING_BRIEF.day
const DAY_MS = 86_400_000

export function trialGuideStep(startedAt: string, now = Date.now()) {
  const days = Math.floor((now - Date.parse(startedAt)) / DAY_MS) + 1
  return TRIAL_GUIDE_STEPS.findLast(step => step.day <= days) ?? TRIAL_GUIDE_STEPS[0]
}

export function nextTrialGuideStepAt(startedAt: string, now = Date.now()) {
  return TRIAL_GUIDE_STEPS.map(step => Date.parse(startedAt) + (step.day - 1) * DAY_MS).find(at => at > now)
}
