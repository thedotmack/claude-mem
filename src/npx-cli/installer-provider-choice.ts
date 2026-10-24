type InstallerProviderId = 'claude' | 'gemini' | 'openrouter' | 'host';
type InstallerProviderChoice = InstallerProviderId | 'cmem';

/** Omitted providers are resolved from saved settings for every host. */
export function resolveInstallerProviderChoice(
  options: { ide?: string; provider?: InstallerProviderId },
): InstallerProviderChoice | undefined {
  if (options.provider) return options.provider;
  return undefined;
}
