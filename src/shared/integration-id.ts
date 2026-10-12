/**
 * `claude` is what people type for Claude Code: `npx claude-mem install --ide
 * claude` and `hook claude <event>`. Canonicalized where an id enters, so every
 * check downstream (IDE validation, the per-host hook limits, the handlers'
 * `platform === 'claude-code'` branches) sees one spelling.
 */
const INTEGRATION_ID_ALIASES: Readonly<Record<string, string>> = {
  claude: 'claude-code', t3: 't3code', 't3-code': 't3code',
  'pi-mono': 'pi', 'deepseek-harness': 'dsh',
};

export function canonicalIntegrationId(id: string): string {
  return INTEGRATION_ID_ALIASES[id] ?? id;
}
