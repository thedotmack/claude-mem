
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
  forHuman: boolean,
  /** The header's date and time; a placeholder when the block is cached (context-cache.ts). */
  headerTime?: string
): string[] {
  const output: string[] = [];
  const fetchByIdSupported = config.fetchByIdSupported !== false;
  const projectDisplay = projectHeaderLabel(project);

  if (forHuman) {
    output.push(...Human.renderHumanHeader(projectDisplay, headerTime));
  } else {
    output.push(...Agent.renderAgentHeader(projectDisplay, headerTime));
  }

  // How to read the timeline, and nothing more: how to use claude-mem's tools
  // is in the MCP server's instructions, not in the startup message.
  if (forHuman) {
    output.push(...Human.renderHumanLegend());
  } else {
    output.push(...Agent.renderAgentLegend(fetchByIdSupported));
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
