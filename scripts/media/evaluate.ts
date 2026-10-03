import { loadEvaluationCorpus } from './corpus.js';
import { runMediaEvaluation } from './evaluation.js';

async function main(): Promise<void> {
  if (process.argv.slice(2).length !== 0) throw new Error('Phase 1 CLI supports dry run only; live execution needs a bounded Phase 7 provider adapter and durable attempt recorder');
  console.log(JSON.stringify(await runMediaEvaluation(await loadEvaluationCorpus()), null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
