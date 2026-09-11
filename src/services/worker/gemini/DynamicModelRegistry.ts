import { logger } from '../../../utils/logger.js';
import type { GeminiModelInfo, ModelCategory } from './types.js';
import { DEFAULT_MODEL_CASCADE, classifyModelCategory } from './model-cascade.js';

interface RawGeminiApiModel {
  name: string;
  version?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  temperature?: number;
  topP?: number;
  topK?: number;
}

interface ModelsApiResponse {
  models?: RawGeminiApiModel[];
}

export class DynamicModelRegistry {
  private static instance: DynamicModelRegistry | null = null;
  private cascade: GeminiModelInfo[] = [...DEFAULT_MODEL_CASCADE];
  private lastDiscoveredAt: number = 0;
  private isDiscovering: boolean = false;

  private constructor() {}

  public static getInstance(): DynamicModelRegistry {
    if (!DynamicModelRegistry.instance) {
      DynamicModelRegistry.instance = new DynamicModelRegistry();
    }
    return DynamicModelRegistry.instance;
  }

  public getCascade(): GeminiModelInfo[] {
    return this.cascade;
  }

  public getModel(modelId: string): GeminiModelInfo | undefined {
    return this.cascade.find(m => m.id === modelId)
      ?? DEFAULT_MODEL_CASCADE.find(m => m.id === modelId);
  }

  public getLastDiscoveredAt(): number {
    return this.lastDiscoveredAt;
  }

  /**
   * Discover and rank available models from Google AI Studio API for the given key.
   */
  public async discoverModels(apiKey: string, force: boolean = false): Promise<GeminiModelInfo[]> {
    if (!apiKey) {
      logger.warn('GEMINI', 'Cannot discover models: No API key provided');
      return this.cascade;
    }

    const now = Date.now();
    // Cache discovery for 1 hour unless forced
    if (!force && this.lastDiscoveredAt > 0 && now - this.lastDiscoveredAt < 3600_000) {
      return this.cascade;
    }

    if (this.isDiscovering) {
      return this.cascade;
    }

    this.isDiscovering = true;
    try {
      logger.info('GEMINI', 'Discovering available Gemini models from Google AI Studio API...');
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        logger.warn('GEMINI', `Model discovery API returned status ${response.status}; using baseline cascade`);
        return this.cascade;
      }

      const data = await response.json() as ModelsApiResponse;
      if (!data.models || !Array.isArray(data.models)) {
        logger.warn('GEMINI', 'Model discovery API returned unexpected payload; using baseline cascade');
        return this.cascade;
      }

      const textModels = data.models.filter(m =>
        m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent')
      );

      const discoveredCascade: GeminiModelInfo[] = [];

      for (const raw of textModels) {
        const id = raw.name.replace(/^models\//, '');
        const defaultInfo = DEFAULT_MODEL_CASCADE.find(m => m.id === id);
        const category = defaultInfo ? defaultInfo.category : classifyModelCategory(id);

        const rpmLimit = defaultInfo ? defaultInfo.rpmLimit : (
          category === 'pro' ? 2 : (category === 'lite' || category === 'gemma' ? 15 : 10)
        );
        const tpmLimit = defaultInfo ? defaultInfo.tpmLimit : (
          category === 'pro' ? 32768 : (category === 'lite' ? 1000000 : 250000)
        );
        const rpdLimit = defaultInfo ? defaultInfo.rpdLimit : (category === 'pro' ? 50 : 1500);

        discoveredCascade.push({
          id,
          displayName: raw.displayName || defaultInfo?.displayName || id,
          category,
          rank: defaultInfo ? defaultInfo.rank : 50, // Temporary rank
          rpmLimit,
          tpmLimit,
          rpdLimit,
          contextWindow: raw.inputTokenLimit || defaultInfo?.contextWindow || 1048576,
          outputLimit: raw.outputTokenLimit || defaultInfo?.outputLimit || 65536,
          supportedGenerationMethods: raw.supportedGenerationMethods,
          description: raw.description || defaultInfo?.description,
          isPerpetualAlias: id.includes('-latest'),
          isPreview: id.includes('-preview'),
        });
      }

      // Sort and assign final continuous rank:
      // Priority ordering rules:
      // 1. Pro (rank priority 1)
      // 2. Flash (rank priority 2)
      // 3. Gemma (rank priority 3)
      // 4. Omni/Agentic (rank priority 4)
      // 5. Lite (rank priority 5)
      // Within each category: default canonical rank first, then version number descending.
      const categoryWeight: Record<ModelCategory, number> = {
        pro: 1,
        flash: 2,
        gemma: 3,
        omni: 4,
        lite: 5
      };

      discoveredCascade.sort((a, b) => {
        const weightDiff = categoryWeight[a.category] - categoryWeight[b.category];
        if (weightDiff !== 0) return weightDiff;

        // Compare known ranks from DEFAULT_MODEL_CASCADE
        const defaultRankA = DEFAULT_MODEL_CASCADE.find(m => m.id === a.id)?.rank ?? 999;
        const defaultRankB = DEFAULT_MODEL_CASCADE.find(m => m.id === b.id)?.rank ?? 999;
        if (defaultRankA !== defaultRankB) return defaultRankA - defaultRankB;

        // Descending alphabetical for new versions
        return b.id.localeCompare(a.id);
      });

      // Assign sequential 1-based rank
      discoveredCascade.forEach((model, index) => {
        model.rank = index + 1;
      });

      this.cascade = discoveredCascade;
      this.lastDiscoveredAt = now;

      logger.info('GEMINI', `Successfully discovered ${discoveredCascade.length} text generation models`, {
        topModel: discoveredCascade[0]?.id,
        totalModels: discoveredCascade.length
      });

      return this.cascade;
    } catch (err: unknown) {
      logger.warn('GEMINI', 'Dynamic model discovery failed (network/timeout); falling back to default cascade', {
        error: err instanceof Error ? err.message : String(err)
      });
      return this.cascade;
    } finally {
      this.isDiscovering = false;
    }
  }
}
