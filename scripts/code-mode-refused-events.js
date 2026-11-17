// Hook events whose registration makes Claude Code's Code Mode (experimental,
// 2.1.323+) refuse to start: at startup it reads the source of every enabled
// plugin's hooks module, so one hook on any of these turns Code Mode off for
// the whole plugin. The list is taken from the Claude Code 2.1.326 binary.
// Shared by scripts/build-hooks.js (assertModBundle) and its test.
export const CODE_MODE_REFUSED_EVENTS = [
  'tool.call',
  'tool.check',
  'tool.judge',
  'tool.run',
  'classic.PreToolUse',
  'classic.PermissionRequest',
  'classic.PermissionDenied',
  'classic.PostToolUse',
  'classic.PostToolUseFailure',
  'agent.offer',
  'agent.spawn',
  'session.send',
  'classic.TaskCreated',
  'classic.TaskCompleted',
  'classic.Elicitation',
  'classic.ElicitationResult',
  'classic.WorktreeCreate',
];

/** The refused events a hooks module's source registers, as `on("<event>", …)` in any quote style. */
export function refusedEventsHooked(source) {
  return CODE_MODE_REFUSED_EVENTS.filter((event) => {
    const escaped = event.replace(/\./g, '\\.');
    return new RegExp(`\\bon\\(\\s*(["'\`])${escaped}\\1`).test(source);
  });
}
