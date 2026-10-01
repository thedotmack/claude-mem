// Fixture: a custom provider module authored as a default object export
// with a `createProvider` method (common CJS-interop shape:
// `module.exports = { createProvider }`).
export default {
  createProvider() {
    return {
      providerLabel: 'claude',
      async generate() {
        return { rawText: 'default-object-export', providerLabel: 'claude' };
      },
    };
  },
};
