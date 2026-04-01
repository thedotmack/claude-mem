import { z } from 'zod';

// YAML frontmatter schema for prompt files
export const SmokeTestSchema = z.object({
  name: z.string(),
  command: z.string(),
  expected: z.string(),
});

export const IndustryBaselineSchema = z.object({
  source: z.enum(['anthropic', 'openai', 'none']),
  reference_cost_usd: z.number().nullable(),
  reference_duration_seconds: z.number().nullable(),
  reference_architecture: z.string().nullable(),
});

export const PromptFrontmatterSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum(['web', 'cli', 'api', 'data', 'fullstack', 'frontend']),
  timeout_hint: z.string(),
  industry_baseline: IndustryBaselineSchema,
  smoke_tests: z.array(SmokeTestSchema),
});

export type SmokeTest = z.infer<typeof SmokeTestSchema>;
export type IndustryBaseline = z.infer<typeof IndustryBaselineSchema>;
export type PromptFrontmatter = z.infer<typeof PromptFrontmatterSchema>;

export interface Prompt {
  frontmatter: PromptFrontmatter;
  body: string;
  filePath: string;
}

export type Arm = 'claude-mem' | 'vanilla';

export interface AgentConfig {
  agentId: string;       // e.g., "cmem-03-2"
  arm: Arm;
  prompt: Prompt;
  replicaIndex: number;
  apiKey: string;
  modelVersion: string;
}

export interface ContainerInfo {
  containerId: string;
  agentId: string;
  arm: Arm;
  promptId: string;
  startTime: Date;
  status: 'running' | 'done' | 'crashed' | 'killed';
}

export interface ManifestEntry {
  agent_id: string;
  arm: Arm;
  prompt_id: string;
  replica_index: number;
  model_version: string;
  container_id: string;
  start_time: string;
}

export interface Manifest {
  benchmark_version: string;
  phase: number;
  started_at: string;
  agents: ManifestEntry[];
}
