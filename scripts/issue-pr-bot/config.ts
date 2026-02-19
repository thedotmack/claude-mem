import type {
  DiscoveryScope,
  OutputSection,
  RepoTarget,
  TriageConfig,
} from "./types.ts";

export interface TriageConfigOverrides {
  repository?: Partial<RepoTarget>;
  discovery?: {
    scope?: DiscoveryScope;
    outdatedThresholdDays?: number;
  };
  output?: {
    sections?: OutputSection[];
  };
  developerPriorityOrder?: string[];
  generatedAt?: Date | string;
}

export const DEFAULT_REPOSITORY: RepoTarget = Object.freeze({
  owner: "thedotmack",
  repo: "claude-mem",
});

export const DEFAULT_DISCOVERY_SCOPE: DiscoveryScope = "open-issues-and-prs";
export const DEFAULT_OUTDATED_THRESHOLD_DAYS = 90;
export const DEFAULT_OUTPUT_SECTIONS = Object.freeze<OutputSection[]>([
  "issues",
  "prs",
]);
export const DEFAULT_DEVELOPER_PRIORITY_ORDER = Object.freeze<string[]>([
  "thedotmack",
  "bigph00t",
  "glucksberg",
]);

function toIsoTimestamp(input?: Date | string): string {
  if (!input) {
    return new Date().toISOString();
  }

  if (input instanceof Date) {
    return input.toISOString();
  }

  return new Date(input).toISOString();
}

export function createTriageConfig(
  overrides: TriageConfigOverrides = {}
): TriageConfig {
  const outputSections =
    overrides.output?.sections && overrides.output.sections.length > 0
      ? [...overrides.output.sections]
      : [...DEFAULT_OUTPUT_SECTIONS];
  const developerPriorityOrder =
    overrides.developerPriorityOrder &&
    overrides.developerPriorityOrder.length > 0
      ? [...overrides.developerPriorityOrder]
      : [...DEFAULT_DEVELOPER_PRIORITY_ORDER];

  return {
    repository: {
      owner: overrides.repository?.owner ?? DEFAULT_REPOSITORY.owner,
      repo: overrides.repository?.repo ?? DEFAULT_REPOSITORY.repo,
    },
    discovery: {
      scope: overrides.discovery?.scope ?? DEFAULT_DISCOVERY_SCOPE,
      outdatedThresholdDays:
        overrides.discovery?.outdatedThresholdDays ??
        DEFAULT_OUTDATED_THRESHOLD_DAYS,
    },
    output: {
      sections: outputSections,
    },
    developerPriorityOrder,
    generatedAt: toIsoTimestamp(overrides.generatedAt),
  };
}
