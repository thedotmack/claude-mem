
import type { ContextConfig } from '../types.js';
import type { Directive } from '../../../types/database.js';
import * as Agent from '../formatters/AgentFormatter.js';
import * as Human from '../formatters/HumanFormatter.js';

export function renderDirectives(
  directives: Directive[],
  config: ContextConfig,
  forHuman: boolean
): string[] {
  if (!config.showDirectives || directives.length === 0) {
    return [];
  }

  const items = directives.map(directive => directive.content);

  return forHuman
    ? Human.renderHumanDirectives(items)
    : Agent.renderAgentDirectives(items);
}
