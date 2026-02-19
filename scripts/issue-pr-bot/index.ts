import { createTriageConfig, type TriageConfigOverrides } from "./config.ts";
import { ingestOpenItems, type IngestionDependencies } from "./ingestion.ts";
import { renderTriageReport } from "./reporting.ts";
import { scoreAndRankItems } from "./scoring.ts";

export interface RunTriagePrototypeOptions {
  configOverrides?: TriageConfigOverrides;
  ingestionDependencies?: IngestionDependencies;
}

export async function runTriagePrototype(
  options: RunTriagePrototypeOptions = {}
) {
  const config = createTriageConfig(options.configOverrides);
  const ingestion = await ingestOpenItems(config, options.ingestionDependencies);
  const scoring = scoreAndRankItems(ingestion.items);
  const report = renderTriageReport(config, scoring);

  return {
    config,
    ingestion,
    scoring,
    report,
  };
}
