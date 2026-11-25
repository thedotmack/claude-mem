export const TRIAL_CONNECT_TASK = 'Use Claude-Mem to find my most recent saved decision or next action. Quote it and show me its source. If I have no synced notes yet, tell me.'

/** Each handoff is an explicit action the person takes in their own connected agent. */
export const TRIAL_GUIDE_STEPS = [
  {
    day: 1, title: 'Save a handoff note',
    instruction: 'Paste this into your first agent, even in a new project. Then connect Claude.ai, ChatGPT, or an agent on another device to the same account.',
    prompt: 'Use Claude-Mem to save a note titled “Cloud Sync handoff”. Include our latest decision and next action. If we just started, use “Next action: choose a project name.” Show me the saved note.',
  },
  {
    day: 3, title: 'Pick up in a second agent',
    instruction: 'Open Claude.ai, ChatGPT, or an agent on another device connected to the same account. Paste this there and compare the answer with your saved note. Need a note first? Choose “Save a handoff note”.',
    prompt: 'Search Claude-Mem for my latest note titled “Cloud Sync handoff”. Quote its saved next action so I can check it. If you cannot find the note, tell me.',
  },
  {
    day: 7, title: 'Hand progress back',
    instruction: 'After working in your second agent, paste this there. Then search for “Cloud Sync handback” in your first agent.',
    prompt: 'Use Claude-Mem to save a note titled “Cloud Sync handback”. Record what changed, one open question, and the next action for the agent that started this task.',
  },
  {
    day: 14, title: 'Repeat on a real project',
    instruction: 'At the end of a work session, paste this into your agent. Take the note title to a second agent and ask it to find the next action.',
    prompt: 'Save a Claude-Mem handoff note for this project with its name, the latest decision, and one concrete next action. Give me the exact note title so my other agent can find it.',
  },
] as const

const DAY_MS = 86_400_000
export function trialGuideStep(startedAt: string, now = Date.now()) {
  const days = Math.floor((now - Date.parse(startedAt)) / DAY_MS) + 1
  return TRIAL_GUIDE_STEPS.findLast(step => step.day <= days) ?? TRIAL_GUIDE_STEPS[0]
}

export function nextTrialGuideStepAt(startedAt: string, now = Date.now()) {
  return TRIAL_GUIDE_STEPS.map(step => Date.parse(startedAt) + (step.day - 1) * DAY_MS).find(at => at > now)
}
