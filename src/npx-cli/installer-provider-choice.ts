type InstallerProviderId = 'claude' | 'gemini' | 'openrouter' | 'host';
type InstallerProviderChoice = InstallerProviderId | 'cmem';

/**
 * Implicit provider when `--provider` is omitted.
 * Grok Bot's user-facing default is CMEM Pro (openrouter transport +
 * cmem-observer via installer OAuth). `--provider host` stays an explicit
 * loopback-shim opt-in. Other IDEs have no non-interactive implicit provider.
 */
export function resolveInstallerProviderChoice(
  options: { ide?: string; provider?: InstallerProviderId },
): InstallerProviderChoice | undefined {
  if (options.provider) return options.provider;
  if (options.ide === 'grok-bot') return 'cmem';
  return undefined;
}
