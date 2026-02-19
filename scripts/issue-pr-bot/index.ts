import { createTriageConfig, type TriageConfigOverrides } from "./config.ts";
import { fetchOpenItemsFromGitHub } from "./github-fetcher.ts";
import { ingestOpenItems, type IngestionDependencies } from "./ingestion.ts";
import { renderTriageReport, writeTriageArtifacts } from "./reporting.ts";
import { scoreAndRankItems } from "./scoring.ts";

export interface RunTriagePrototypeOptions {
  configOverrides?: TriageConfigOverrides;
  ingestionDependencies?: IngestionDependencies;
  outputRootDir?: string;
  writeArtifacts?: boolean;
}

export async function runTriagePrototype(
  options: RunTriagePrototypeOptions = {}
) {
  const config = createTriageConfig(options.configOverrides);
  const ingestionDependencies: IngestionDependencies = {
    fetchOpenItems: fetchOpenItemsFromGitHub,
    ...options.ingestionDependencies,
  };
  const ingestion = await ingestOpenItems(config, ingestionDependencies);
  const scoring = scoreAndRankItems(ingestion.items, {
    now: config.generatedAt,
    outdatedThresholdDays: config.discovery.outdatedThresholdDays,
    developerPriorityOrder: config.developerPriorityOrder,
  });
  const report = renderTriageReport(config, scoring);
  if (options.writeArtifacts !== false) {
    report.artifacts = await writeTriageArtifacts(config, report, {
      outputRootDir: options.outputRootDir,
    });
  }

  return {
    config,
    ingestion,
    scoring,
    report,
  };
}
