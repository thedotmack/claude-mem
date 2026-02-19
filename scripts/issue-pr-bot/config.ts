import type { RepoTarget, TriageConfig } from "./types.ts";

export interface TriageConfigOverrides {
  repository?: Partial<RepoTarget>;
  generatedAt?: Date | string;
}

export const DEFAULT_REPOSITORY: RepoTarget = Object.freeze({
  owner: "thedotmack",
  repo: "claude-mem",
});

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
  return {
    repository: {
      owner: overrides.repository?.owner ?? DEFAULT_REPOSITORY.owner,
      repo: overrides.repository?.repo ?? DEFAULT_REPOSITORY.repo,
    },
    generatedAt: toIsoTimestamp(overrides.generatedAt),
  };
}
