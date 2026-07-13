// Fixture: a custom provider module authored as a named `createProvider`
// export — one of the three factory shapes loadCustomServerGenerationProvider
// must recognize.
export function createProvider(helpers) {
  return {
    providerLabel: 'claude',
    async generate() {
      return {
        rawText: `buildServerGenerationPrompt:${typeof helpers.buildServerGenerationPrompt} ClaudeObservationProvider:${typeof helpers.ClaudeObservationProvider}`,
        providerLabel: 'claude',
      };
    },
  };
}
