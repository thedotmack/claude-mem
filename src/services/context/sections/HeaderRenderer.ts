
import type { ContextConfig, TokenEconomics } from '../types.js';
import { shouldShowContextEconomics } from '../TokenCalculator.js';
import { loadProjectEnvironments } from '../../../utils/project-name.js';
import * as Agent from '../formatters/AgentFormatter.js';
import * as Human from '../formatters/HumanFormatter.js';

/**
 * A named environment spans several directories; say so in the header so the
 * model does not read the project name as one folder. The name only: the glob
 * patterns would cost tokens on every session and add nothing for the model.
 */
function projectHeaderLabel(project: string): string {
  return loadProjectEnvironments().some(environment => environment.name === project)
    ? `${project} (environment)`
    : project;
}

export function renderHeader(
  project: string,
  economics: TokenEconomics,
  config: ContextConfig,
  forHuman: boolean
): string[] {
  const output: string[] = [];
  const fetchByIdSupported = config.fetchByIdSupported !== false;
  const projectDisplay = projectHeaderLabel(project);

  if (forHuman) {
    output.push(...Human.renderHumanHeader(projectDisplay));
  } else {
    output.push(...Agent.renderAgentHeader(projectDisplay));
  }

  if (forHuman) {
    output.push(...Human.renderHumanLegend());
  } else {
    output.push(...Agent.renderAgentLegend(fetchByIdSupported));
  }

  // Agent variants render nothing; only the Human column-key / context-index
  // arms produce output.
  if (forHuman) {
    output.push(...Human.renderHumanColumnKey());
    output.push(...Human.renderHumanContextIndex(fetchByIdSupported));
  }

  if (shouldShowContextEconomics(config)) {
    if (forHuman) {
      output.push(...Human.renderHumanContextEconomics(economics, config));
    } else {
      output.push(...Agent.renderAgentContextEconomics(economics, config));
    }
  }

  return output;
}
