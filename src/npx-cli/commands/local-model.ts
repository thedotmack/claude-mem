// SPDX-License-Identifier: Apache-2.0
//
// `npx claude-mem local-model check|setup` — test whether this machine can run
// memory compression on a local model (free, no API costs), and switch to it.
//
//   check  — read-only: hardware verdict + detected runtimes + installed
//            models. Exits 0 when the machine is capable, 1 otherwise
//            (script-friendly, like `doctor`).
//   setup  — writes the provider settings to use a detected local runtime
//            (or an explicit --endpoint), then prints the restart hint.

import { join } from 'path';
import { styleText } from 'node:util';
import { parseArgs } from 'node:util';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { readFlatSettings } from '../utils/settings.js';
import {
  assessHardware,
  localModelSettingsDelta,
  probeLmStudio,
  probeOllama,
  type HardwareAssessment,
  type RuntimeProbe,
} from '../../shared/local-model.js';

function settingsPath(): string {
  return join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
}

function printHardware(hw: HardwareAssessment): void {
  const chip = hw.appleSilicon ? 'Apple Silicon' : `${hw.platform}/${hw.arch}`;
  console.log(`  Hardware: ${hw.ramGb}GB RAM, ${hw.cpuCount} CPUs (${chip})`);
  if (hw.tier === 'insufficient') {
    console.log(`  Verdict:  ${styleText('yellow', 'below 8GB RAM — a local model would swap; cloud providers are the better fit here')}`);
  } else {
    console.log(`  Verdict:  ${styleText('green', `can run a ~${hw.recommendedParamSize} model`)} (suggested: ${hw.recommendedOllamaModel})`);
  }
}

function printRuntime(probe: RuntimeProbe): void {
  const label = probe.name === 'ollama' ? 'Ollama' : 'LM Studio';
  if (!probe.detected) {
    console.log(`  ${label}: not detected`);
    return;
  }
  const models = probe.models.length > 0 ? probe.models.join(', ') : 'no models loaded';
  console.log(`  ${label}: ${styleText('green', 'running')} at ${probe.openAiBaseUrl} (${models})`);
}

async function runCheck(): Promise<void> {
  const hw = assessHardware();
  const [ollama, lmstudio] = await Promise.all([probeOllama(), probeLmStudio()]);

  console.log(styleText('bold', 'Local model capability check'));
  printHardware(hw);
  printRuntime(ollama);
  printRuntime(lmstudio);

  const capable = hw.tier !== 'insufficient';
  const detected = [ollama, lmstudio].find(p => p.detected);

  if (capable && detected && detected.models.length > 0) {
    console.log(`\nReady. Switch memory compression to a local model (free) with:`);
    console.log(`  ${styleText('cyan', 'npx claude-mem local-model setup')}`);
  } else if (capable && detected) {
    console.log(`\nRuntime found but no model installed. Pull one, then run setup:`);
    console.log(`  ${styleText('cyan', `ollama pull ${hw.recommendedOllamaModel}`)}`);
    console.log(`  ${styleText('cyan', 'npx claude-mem local-model setup')}`);
  } else if (capable) {
    console.log(`\nNo local runtime detected. Install one, pull a model, then run setup:`);
    console.log(`  Ollama:    ${styleText('cyan', 'https://ollama.com')} then ${styleText('cyan', `ollama pull ${hw.recommendedOllamaModel}`)}`);
    console.log(`  LM Studio: ${styleText('cyan', 'https://lmstudio.ai')}`);
  }

  process.exit(capable ? 0 : 1);
}

async function runSetup(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: 'string' },
      endpoint: { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  });
  const modelFlag = typeof values.model === 'string' ? values.model : undefined;
  const endpointFlag = typeof values.endpoint === 'string' ? values.endpoint : undefined;

  let endpoint = endpointFlag;
  let model = modelFlag;

  if (!endpoint) {
    const [ollama, lmstudio] = await Promise.all([probeOllama(), probeLmStudio()]);
    const detected = [ollama, lmstudio].find(p => p.detected);
    if (!detected) {
      console.error(styleText('red', 'No local runtime detected (Ollama on :11434, LM Studio on :1234).'));
      console.error('Start one, or pass an explicit endpoint: npx claude-mem local-model setup --endpoint <url> --model <id>');
      process.exit(1);
    }
    endpoint = detected.openAiBaseUrl;
    if (!model) {
      const hw = assessHardware();
      // Prefer the tier-recommended model when it is installed; otherwise the
      // first installed model. Never guess a model the runtime doesn't have.
      model = detected.models.find(m => hw.recommendedOllamaModel && m.startsWith(hw.recommendedOllamaModel))
        ?? detected.models[0];
      if (!model) {
        console.error(styleText('red', `${detected.name === 'ollama' ? 'Ollama' : 'LM Studio'} is running but has no models.`));
        if (detected.name === 'ollama' && hw.recommendedOllamaModel) {
          console.error(`Pull one first: ollama pull ${hw.recommendedOllamaModel}`);
        }
        process.exit(1);
      }
    }
  } else if (!model) {
    console.error(styleText('red', '--endpoint requires --model (the model id the endpoint serves).'));
    process.exit(1);
  }

  const path = settingsPath();
  const existing = (() => {
    try {
      return readFlatSettings(path) ?? {};
    } catch {
      console.error(styleText('red', `Could not parse ${path} — fix or remove it, then re-run.`));
      process.exit(1);
    }
  })();

  const next = { ...existing, ...localModelSettingsDelta(endpoint!, model!) };
  writeJsonFileAtomic(path, next);

  console.log(styleText('green', 'Memory compression switched to a local model (free, no API costs).'));
  console.log(`  Provider: openrouter (OpenAI-compatible)`);
  console.log(`  Endpoint: ${endpoint}`);
  console.log(`  Model:    ${model}`);
  console.log(`  Settings: ${path}`);
  console.log(`\nApply it: ${styleText('cyan', 'npx claude-mem restart')}`);
}

export async function runLocalModelCommand(argv: string[] = []): Promise<void> {
  const subCommand = argv[0]?.toLowerCase() ?? 'check';
  if (subCommand === 'check') {
    await runCheck();
    return;
  }
  if (subCommand === 'setup') {
    await runSetup(argv.slice(1));
    return;
  }
  console.error(styleText('red', `Unknown local-model subcommand: ${subCommand}`));
  console.error('Usage: npx claude-mem local-model check|setup [--model <id>] [--endpoint <url>]');
  process.exit(1);
}
