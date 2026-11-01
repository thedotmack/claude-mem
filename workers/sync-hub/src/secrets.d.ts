/**
 * Secret bindings — set via `wrangler secret put` (DEPLOY.md), deliberately
 * NOT declared in wrangler.jsonc vars: a var and a secret share one
 * namespace, and a committed var would shadow (or conflict with) the secret
 * at deploy time. `wrangler types` only generates config-declared bindings,
 * so the secrets are typed here via global interface merging with the
 * generated `Env` (worker-configuration.d.ts). Optional on purpose: the
 * watchdog treats absence as "unconfigured": it logs loudly, Discord-pages
 * when the webhook secret is set, and never fabricates a metrics breach.
 */
interface Env {
	/**
	 * When set (non-empty), the Worker proxies every request — including
	 * WebSocket upgrades — to this origin and touches zero DO and zero KV.
	 * Empty / unset keeps today's Durable Object + KV path.
	 */
	FORWARD_ORIGIN?: string;
	/** Shared Hub/Pro internal projector and payload-free metadata credential. */
	CMEM_INTERNAL_PROJECTOR_SECRET?: string;
	/**
	 * Cloudflare API token for the GraphQL Analytics API.
	 * Scope: Account → Account Analytics → Read.
	 * `wrangler secret put ANALYTICS_API_TOKEN`
	 */
	ANALYTICS_API_TOKEN?: string;
	/**
	 * Discord webhook URL for watchdog alerts (runtime credential lives in
	 * ~/Scripts/claude-mem/.env as DISCORD_UPDATES_WEBHOOK — NEVER hardcode
	 * or commit a webhook URL).
	 * `wrangler secret put DISCORD_WEBHOOK_URL`
	 */
	DISCORD_WEBHOOK_URL?: string;
}
