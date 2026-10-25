// SPDX-License-Identifier: Apache-2.0
//
// A user prompt and an assistant reply as context rows. The startup context
// shows the previous session's last reply as `A: <text>` (the Previously
// section, renderAgentPreviouslySection); Endless Mode's timeline shows each
// finished turn's prompt and final reply the same way, the prompt as `U: <text>`.

export function renderAgentAssistantMessageRow(text: string): string {
  return `A: ${text}`;
}

export function renderAgentUserPromptRow(text: string): string {
  return `U: ${text}`;
}
