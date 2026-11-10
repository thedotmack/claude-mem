import { ContextReadWorkerClient } from '../../src/services/context/ContextReadWorkerClient.js';
const reader = new ContextReadWorkerClient();
try {
  console.log(JSON.stringify({
    observations: await reader.searchObservations(undefined, { project: 'app' }),
    projects: await reader.projectsForCwd(process.env.CM_PROBE_CWD!),
    runtime: { main: Bun.main, version: process.versions.bun },
  }));
} finally { await reader.close(); }
