import { parseArgs } from 'node:util';

export interface BenchmarkConfig {
  phase: 1 | 2;
  promptsDir: string;
  keysEnvPath: string;
  resultsDir: string;
  replicas: number;
  dryRun: boolean;
  batchSize: number;
  dockerImage: string;
}

export function parseConfig(): BenchmarkConfig {
  const { values } = parseArgs({
    options: {
      phase: { type: 'string', default: '1' },
      'prompts-dir': { type: 'string', default: './prompts' },
      'keys-env': { type: 'string', default: './keys.env' },
      'results-dir': { type: 'string', default: './results' },
      replicas: { type: 'string', default: undefined },
      'dry-run': { type: 'boolean', default: false },
      'batch-size': { type: 'string', default: '10' },
      'docker-image': { type: 'string', default: 'benchmark-agent' },
    },
    strict: false,
  });

  const phase = Number(values.phase) as 1 | 2;
  if (phase !== 1 && phase !== 2) {
    throw new Error(`Invalid phase: ${values.phase}. Must be 1 or 2.`);
  }

  const replicas = values.replicas
    ? Number(values.replicas)
    : phase === 1 ? 1 : 5;

  return {
    phase,
    promptsDir: values['prompts-dir'] as string,
    keysEnvPath: values['keys-env'] as string,
    resultsDir: values['results-dir'] as string,
    replicas,
    dryRun: values['dry-run'] as boolean,
    batchSize: Number(values['batch-size']),
    dockerImage: values['docker-image'] as string,
  };
}
