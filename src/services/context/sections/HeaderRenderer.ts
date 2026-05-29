
import type { ContextConfig, TokenEconomics } from '../types.js';
import { shouldShowContextEconomics } from '../TokenCalculator.js';
import { loadEnvironments } from '../../../utils/project-name.js';
import * as Agent from '../formatters/AgentFormatter.js';
import * as Human from '../formatters/HumanFormatter.js';

function getEnvironmentHint(projectName: string): string | null {
  const environments = loadEnvironments();
  const matched = environments.find(env => env.name === projectName);
  if (!matched) return null;
  return `environment, paths: ${matched.patterns.join(', ')}`;
}

export function renderHeader(
  project: string,
  economics: TokenEconomics,
  config: ContextConfig,
  forHuman: boolean
): string[] {
  const output: string[] = [];
  const envHint = getEnvironmentHint(project);
  const projectDisplay = envHint ? `${project} (${envHint})` : project;

  if (forHuman) {
    output.push(...Human.renderHumanHeader(projectDisplay));
  } else {
    output.push(...Agent.renderAgentHeader(projectDisplay));
  }

  if (forHuman) {
    output.push(...Human.renderHumanLegend());
  } else {
    output.push(...Agent.renderAgentLegend());
  }

  if (forHuman) {
    output.push(...Human.renderHumanColumnKey());
  } else {
    output.push(...Agent.renderAgentColumnKey());
  }

  if (forHuman) {
    output.push(...Human.renderHumanContextIndex());
  } else {
    output.push(...Agent.renderAgentContextIndex());
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
