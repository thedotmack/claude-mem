
import type { PriorMessages } from '../types.js';
import * as Agent from '../formatters/AgentFormatter.js';
import * as Human from '../formatters/HumanFormatter.js';

/**
 * The prior session's last reply ("Include last message"). Both renders put it
 * above the timeline: the timeline ends the startup message, with no closing
 * lines after it, so later updates can append timeline rows to it.
 */
export function renderPreviouslySection(
  priorMessages: PriorMessages,
  forHuman: boolean
): string[] {
  if (forHuman) {
    return Human.renderHumanPreviouslySection(priorMessages);
  }
  return Agent.renderAgentPreviouslySection(priorMessages);
}
