import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseConfig } from './config.js';
import { ContainerManager } from './container-manager.js';
import { getKeyForAgent, loadKeys } from './key-distributor.js';
import { loadPrompts } from './prompt-loader.js';
import type {
  AgentConfig,
  Arm,
  ContainerInfo,
  Manifest,
  ManifestEntry,
} from './types.js';

const ARMS: Arm[] = ['claude-mem', 'vanilla'];

/**
 * Generates an agent ID from arm, prompt ID, and replica index.
 * Format: {armPrefix}-{promptId}-{replica}
 */
function generateAgentId(arm: Arm, promptId: string, replicaIndex: number): string {
  const armPrefix = arm === 'claude-mem' ? 'cmem' : 'vanilla';
  return `${armPrefix}-${promptId}-${replicaIndex}`;
}

/**
 * Generates all agent configs for the benchmark run.
 */
function generateAgentConfigs(
  prompts: Awaited<ReturnType<typeof loadPrompts>>,
  agentKeys: string[],
  modelVersion: string,
  replicas: number,
): AgentConfig[] {
  const configs: AgentConfig[] = [];
  let agentIndex = 0;

  for (const prompt of prompts) {
    for (let replicaIndex = 1; replicaIndex <= replicas; replicaIndex++) {
      for (const arm of ARMS) {
        const agentId = generateAgentId(arm, prompt.frontmatter.id, replicaIndex);
        const apiKey = getKeyForAgent(agentKeys, agentIndex);
        configs.push({
          agentId,
          arm,
          prompt,
          replicaIndex,
          apiKey,
          modelVersion,
        });
        agentIndex++;
      }
    }
  }

  return configs;
}

/**
 * Launches agents in batches, waiting for each batch to start before moving on.
 */
async function launchInBatches(
  containerManager: ContainerManager,
  agentConfigs: AgentConfig[],
  dockerImage: string,
  resultsDir: string,
  batchSize: number,
): Promise<ContainerInfo[]> {
  const allContainerInfos: ContainerInfo[] = [];

  for (let batchStart = 0; batchStart < agentConfigs.length; batchStart += batchSize) {
    const batch = agentConfigs.slice(batchStart, batchStart + batchSize);
    const batchNumber = Math.floor(batchStart / batchSize) + 1;
    const totalBatches = Math.ceil(agentConfigs.length / batchSize);

    console.log(
      `Launching batch ${batchNumber}/${totalBatches} (${batch.length} agents)...`,
    );

    const batchResults = await Promise.all(
      batch.map((config) =>
        containerManager.launchAgent(config, dockerImage, resultsDir),
      ),
    );

    allContainerInfos.push(...batchResults);

    console.log(
      `Batch ${batchNumber} launched. ${allContainerInfos.length}/${agentConfigs.length} agents running.`,
    );
  }

  return allContainerInfos;
}

/**
 * Builds the manifest object for the benchmark run.
 */
function buildManifest(
  phase: number,
  agentConfigs: AgentConfig[],
  containerInfos: ContainerInfo[],
): Manifest {
  const containerMap = new Map<string, ContainerInfo>();
  for (const info of containerInfos) {
    containerMap.set(info.agentId, info);
  }

  const agents: ManifestEntry[] = agentConfigs.map((config) => {
    const containerInfo = containerMap.get(config.agentId);
    return {
      agent_id: config.agentId,
      arm: config.arm,
      prompt_id: config.prompt.frontmatter.id,
      replica_index: config.replicaIndex,
      model_version: config.modelVersion,
      container_id: containerInfo?.containerId ?? 'dry-run',
      start_time: containerInfo?.startTime.toISOString() ?? new Date().toISOString(),
    };
  });

  return {
    benchmark_version: '0.1.0',
    phase,
    started_at: new Date().toISOString(),
    agents,
  };
}

async function main(): Promise<void> {
  const config = parseConfig();

  console.log(`Benchmark orchestrator starting (phase ${config.phase})`);
  console.log(`  Prompts dir: ${config.promptsDir}`);
  console.log(`  Results dir: ${config.resultsDir}`);
  console.log(`  Replicas: ${config.replicas}`);
  console.log(`  Batch size: ${config.batchSize}`);
  console.log(`  Dry run: ${config.dryRun}`);

  // Load prompts
  const prompts = await loadPrompts(config.promptsDir);
  console.log(`Loaded ${prompts.length} prompts`);

  // Load and validate keys
  const keys = await loadKeys(config.keysEnvPath);
  console.log(
    `Loaded ${keys.agentKeys.length} agent key(s), model: ${keys.modelVersion}`,
  );

  // Generate agent configs
  const agentConfigs = generateAgentConfigs(
    prompts,
    keys.agentKeys,
    keys.modelVersion,
    config.replicas,
  );
  console.log(
    `Generated ${agentConfigs.length} agent configs ` +
      `(${prompts.length} prompts x ${config.replicas} replicas x ${ARMS.length} arms)`,
  );

  if (config.dryRun) {
    console.log('\n--- DRY RUN: Agent configs ---');
    const dryRunOutput = agentConfigs.map((c) => ({
      agentId: c.agentId,
      arm: c.arm,
      promptId: c.prompt.frontmatter.id,
      replicaIndex: c.replicaIndex,
      modelVersion: c.modelVersion,
      // Mask the key for security
      apiKeyPrefix: c.apiKey.slice(0, 12) + '...',
    }));
    console.log(JSON.stringify(dryRunOutput, null, 2));
    return;
  }

  // Ensure results directory exists
  const absoluteResultsDir = resolve(config.resultsDir);
  await mkdir(absoluteResultsDir, { recursive: true });

  // Build Docker images if not cached
  const containerManager = new ContainerManager();
  for (const arm of ARMS) {
    const imageTag = `${config.dockerImage}:${arm}`;
    const alreadyExists = await containerManager.imageExists(imageTag);
    if (alreadyExists) {
      console.log(`Image ${imageTag} already exists, skipping build.`);
    } else {
      console.log(`Building image ${imageTag}...`);
      await containerManager.buildImage(
        join(config.promptsDir, '..', 'Dockerfile'),
        config.dockerImage,
        arm,
      );
      console.log(`Image ${imageTag} built successfully.`);
    }
  }

  // Launch containers in batches
  const containerInfos = await launchInBatches(
    containerManager,
    agentConfigs,
    config.dockerImage,
    absoluteResultsDir,
    config.batchSize,
  );

  // Write manifest
  const manifest = buildManifest(config.phase, agentConfigs, containerInfos);
  const manifestPath = join(absoluteResultsDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Manifest written to ${manifestPath}`);

  // Summary
  console.log('\n--- Benchmark Launch Summary ---');
  console.log(`  Phase: ${config.phase}`);
  console.log(`  Total agents: ${containerInfos.length}`);
  console.log(
    `  claude-mem agents: ${containerInfos.filter((c) => c.arm === 'claude-mem').length}`,
  );
  console.log(
    `  vanilla agents: ${containerInfos.filter((c) => c.arm === 'vanilla').length}`,
  );
  console.log(`  Containers are running autonomously. Check results in: ${absoluteResultsDir}`);
}

main().catch((error: Error) => {
  console.error(`Fatal: ${error.name}: ${error.message}`);
  process.exit(1);
});
