import { categorizeItems } from "./categorizer.ts";
import { createTriageConfig, type TriageConfigOverrides } from "./config.ts";
import { detectDuplicates } from "./duplicate-detector.ts";
import { fetchOpenItemsFromGitHub } from "./github-fetcher.ts";
import { ingestOpenItems, type IngestionDependencies } from "./ingestion.ts";
import { generateRecommendations } from "./recommender.ts";
import { renderTriageReport, writeTriageArtifacts } from "./reporting.ts";
import { scoreAndRankItems } from "./scoring.ts";
import type { TriageResult } from "./types.ts";

export interface RunTriagePrototypeOptions {
  configOverrides?: TriageConfigOverrides;
  ingestionDependencies?: IngestionDependencies;
  outputRootDir?: string;
  writeArtifacts?: boolean;
}

export async function runTriagePrototype(
  options: RunTriagePrototypeOptions = {}
): Promise<TriageResult> {
  const config = createTriageConfig(options.configOverrides);
  const ingestionDependencies: IngestionDependencies = {
    fetchOpenItems: fetchOpenItemsFromGitHub,
    ...options.ingestionDependencies,
  };
  const ingestion = await ingestOpenItems(config, ingestionDependencies);

  // Categorize after ingestion
  const categorized = categorizeItems(ingestion.items);

  const scoring = scoreAndRankItems(ingestion.items, {
    now: config.generatedAt,
    outdatedThresholdDays: config.discovery.outdatedThresholdDays,
    developerPriorityOrder: config.developerPriorityOrder,
  });

  // Detect duplicates after categorization
  const duplicateGroups = detectDuplicates(categorized);

  // Generate recommendations based on categorization and duplicate detection
  const recommendations = generateRecommendations(categorized, duplicateGroups, config);

  const report = renderTriageReport(config, scoring, { categorized, duplicateGroups, recommendations });
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
    categorized,
    duplicateGroups,
    recommendations,
  };
}
