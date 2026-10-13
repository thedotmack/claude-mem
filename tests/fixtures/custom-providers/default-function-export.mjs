// Fixture: a custom provider module authored as a default function export.
export default function createProvider() {
  return {
    providerLabel: 'claude',
    async generate() {
      return { rawText: 'default-function-export', providerLabel: 'claude' };
    },
  };
}
