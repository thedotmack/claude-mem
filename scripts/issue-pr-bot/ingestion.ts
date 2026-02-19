import type { IngestionResult, NormalizedItem, TriageConfig } from "./types.ts";

export interface IngestionDependencies {
  fetchOpenItems?: (config: TriageConfig) => Promise<NormalizedItem[]>;
}

const SCAFFOLD_WARNING =
  "GitHub ingestion scaffold is ready, but live API fetching is not implemented yet.";

export async function ingestOpenItems(
  config: TriageConfig,
  dependencies: IngestionDependencies = {}
): Promise<IngestionResult> {
  if (dependencies.fetchOpenItems) {
    const items = await dependencies.fetchOpenItems(config);
    return {
      items,
      warnings: [],
    };
  }

  return {
    items: [],
    warnings: [SCAFFOLD_WARNING],
  };
}

export { SCAFFOLD_WARNING };
