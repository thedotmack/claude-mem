/**
 * The corpus agent: what answers a question about a knowledge corpus.
 *
 * There are two of them, and which one runs is the owner's choice, not the
 * code's. A corpus answered through the Anthropic Agent SDK spends the
 * owner's Claude subscription, and that stays the default. An owner who wants
 * the corpus on the API provider they selected opts in with
 * `CLAUDE_MEM_CORPUS_AGENT=api`: the API agent then answers the same
 * questions over chat completions and spends that provider's credit.
 *
 * The Claude agent's module imports `@anthropic-ai/claude-agent-sdk` at the
 * top level, so it is imported here dynamically and only on the Claude
 * branch. With `api` selected the Anthropic SDK is never loaded at all: an
 * install that routed away from that account does not even open it.
 */

import { resolveSelectedApiProvider, type ApiProviderId } from '../../agent-runner/api-agent.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { paths } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';
import { AppError } from '../../server/ErrorHandler.js';
import { ApiCorpusAgent, isApiSessionId } from './ApiCorpusAgent.js';
import type { CorpusStore } from './CorpusStore.js';
import type { CorpusFile, KnowledgeAgentCallOptions, QueryResult } from './types.js';

/**
 * The contract every corpus agent keeps: prime a corpus, answer a question
 * about it, prime it again. The Agent SDK agent and the API agent both
 * satisfy it exactly, so the route does not know which one it holds.
 */
export interface CorpusAgent {
  /** Load the corpus and return the session id it is now answerable under. */
  prime(corpus: CorpusFile, callOptions?: KnowledgeAgentCallOptions): Promise<string>;
  /** Answer a question from the corpus. */
  query(corpus: CorpusFile, question: string, callOptions?: KnowledgeAgentCallOptions): Promise<QueryResult>;
  /** Prime the corpus again, replacing the session it was primed under. */
  reprime(corpus: CorpusFile, callOptions?: KnowledgeAgentCallOptions): Promise<string>;
}

/** A corpus agent that picks the implementation per call; `current` names the one a call would use now. */
export interface ProviderCorpusAgent extends CorpusAgent {
  current(): Promise<CorpusAgent>;
}

/**
 * The corpus agent the settings choose, chosen on every call.
 *
 * `CLAUDE_MEM_CORPUS_AGENT` is read when a prime or a query starts, not once
 * at worker start: an owner who opts in or out must not wait for a restart.
 * Empty (the default) is the Claude Agent SDK; `api` is the selected API
 * provider. `api` on a provider that is not an API endpoint is an error, not
 * a quiet move to Claude: the owner asked for an agent that cannot run, and
 * running another one would spend an account they did not choose.
 *
 * `settingsPath` is the settings file read; it defaults to the one the
 * worker uses.
 */
export async function createCorpusAgent(
  corpusStore: CorpusStore,
  settingsPath?: string,
): Promise<ProviderCorpusAgent> {
  const apiAgents = new Map<ApiProviderId, ApiCorpusAgent>();
  let claudeAgent: Promise<CorpusAgent> | null = null;

  const select = async (): Promise<CorpusAgent> => {
    const wanted = String(SettingsDefaultsManager.loadFromFile(settingsPath ?? paths.settings()).CLAUDE_MEM_CORPUS_AGENT ?? '').trim().toLowerCase();
    // The settings route only saves '' or 'api', but the file can be edited by hand. A value this
    // code does not know must not fall through to the Claude Agent SDK: that is the account an
    // owner who wrote something here was trying to leave.
    if (wanted !== '' && wanted !== 'api') {
      throw new AppError(
        `CLAUDE_MEM_CORPUS_AGENT is ${JSON.stringify(wanted.slice(0, 40))}; it must be empty (Claude Agent SDK) or "api" (the selected openrouter / openai-compatible provider).`,
        400,
        'CORPUS_AGENT_UNAVAILABLE',
      );
    }
    if (wanted === 'api') {
      const provider = resolveSelectedApiProvider(settingsPath);
      if (!provider) {
        throw new AppError(
          'CLAUDE_MEM_CORPUS_AGENT is "api", but CLAUDE_MEM_PROVIDER is not openrouter or openai-compatible. Select one of them, or empty the setting to use the Claude Agent SDK.',
          400,
          'CORPUS_AGENT_UNAVAILABLE',
        );
      }
      let agent = apiAgents.get(provider);
      if (!agent) {
        logger.info('WORKER', `Corpus agent runs on the selected provider (${provider}) because CLAUDE_MEM_CORPUS_AGENT=api`);
        agent = new ApiCorpusAgent(corpusStore, provider, settingsPath);
        apiAgents.set(provider, agent);
      }
      return agent;
    }
    // Only now is the Anthropic Agent SDK loaded, and only on this branch.
    // A failed import is not kept: the next call tries again instead of rethrowing it until a restart.
    claudeAgent ??= import('./KnowledgeAgent.js')
      .then(({ KnowledgeAgent }) => new KnowledgeAgent(corpusStore))
      .catch((error: unknown) => { claudeAgent = null; throw error; });
    return claudeAgent;
  };

  return {
    current: select,
    prime: async (corpus, callOptions) => (await select()).prime(corpus, callOptions),
    query: async (corpus, question, callOptions) => {
      const agent = await select();
      // A corpus primed by the API agent holds a synthetic session id. The
      // Agent SDK would take it for a session to resume, fail, and re-prime on
      // the owner's Claude plan. The owner switched agents, so the corpus is
      // not primed for this one: the same answer a never-primed corpus gets.
      if (!(agent instanceof ApiCorpusAgent) && isApiSessionId(corpus.session_id)) {
        throw new AppError(`Corpus "${corpus.name}" has no session — call prime first`, 409, 'CORPUS_NOT_PRIMED');
      }
      return agent.query(corpus, question, callOptions);
    },
    reprime: async (corpus, callOptions) => (await select()).reprime(corpus, callOptions),
  };
}
