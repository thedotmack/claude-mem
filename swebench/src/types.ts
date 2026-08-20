/**
 * Shared types for the claude-mem SWE-bench harness.
 *
 * The instance shape mirrors the columns of the official SWE-bench datasets
 * (princeton-nlp/SWE-bench_Verified and SWE-bench_Lite). Only the fields the
 * harness actually consumes are typed; unknown extra columns are preserved via
 * the index signature so nothing is lost when re-serializing.
 */
export interface SweBenchInstance {
  /** Unique id, e.g. "astropy__astropy-12345". */
  instance_id: string;
  /** "owner/name" of the source repository. */
  repo: string;
  /** Commit the repo must be checked out at before applying a fix. */
  base_commit: string;
  /** The issue text the agent must resolve. */
  problem_statement: string;
  /** Gold patch (solution). Never shown to the agent; used only for reference. */
  patch?: string;
  /** Gold test patch that introduces/adjusts the grading tests. */
  test_patch?: string;
  /** Tests expected to flip from fail→pass once the issue is fixed. */
  FAIL_TO_PASS?: string | string[];
  /** Tests expected to remain passing (regression guard). */
  PASS_TO_PASS?: string | string[];
  /** Package version the environment image is built for. */
  version?: string;
  /** Commit whose environment/deps the official image pins to. */
  environment_setup_commit?: string;
  /** Extra hints occasionally present in some splits. */
  hints_text?: string;
  [extra: string]: unknown;
}

/**
 * A single SWE-bench prediction row. This is exactly the schema the official
 * harness (`swebench.harness.run_evaluation`) expects in its predictions file.
 */
export interface Prediction {
  instance_id: string;
  /** The model/scaffold identifier that appears on the leaderboard. */
  model_name_or_path: string;
  /** The unified diff the agent produced (may be empty on failure). */
  model_patch: string;
}

/** Per-instance solve result, richer than the graded prediction row. */
export interface SolveResult {
  instance_id: string;
  patch: string;
  /** Whether the loop produced a non-empty patch. */
  succeeded: boolean;
  /** Number of assistant turns the agent took. */
  turns: number;
  /** Tool calls the agent made, by tool name. */
  toolCallCounts: Record<string, number>;
  /** Number of mem-search tool invocations (search+timeline+get_observations). */
  memSearchCalls: number;
  usage: TokenUsage;
  /** Wall-clock milliseconds spent solving this instance. */
  durationMs: number;
  /** Populated when the loop threw or bailed. */
  error?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Sum of OpenRouter-reported credit cost (~USD), when available. */
  costUsd?: number;
}

/** OpenAI/OpenRouter chat message. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Present on assistant messages that request tool calls. */
  tool_calls?: ToolCall[];
  /** Present on role:"tool" messages, referencing the call being answered. */
  tool_call_id?: string;
  /** Optional label for tool messages. */
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded argument object. */
    arguments: string;
  };
}

/** A tool the agent may call, in OpenAI function-tool schema. */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** The result of executing a single tool call. */
export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string;
}

/** Minimal contract a chat provider must satisfy for the solver loop. */
export interface ChatProvider {
  readonly modelName: string;
  complete(input: {
    messages: ChatMessage[];
    tools: ToolDefinition[];
    signal?: AbortSignal;
  }): Promise<ChatCompletion>;
}

export interface ChatCompletion {
  message: ChatMessage;
  finishReason: string;
  usage: TokenUsage;
}
