/**
 * ESLint flat config — anti-pattern guards for Durable Object code
 * (plan Phase 0.3/0.4). The `src/do/**` glob is load-bearing: CI greps and
 * these rules both target it, so ALL Durable Object code must live there.
 *
 * Guarded traps:
 *   - setTimeout/setInterval in the DO pins it awake (anti-pattern #2) —
 *     alarms only.
 *   - Any outbound fetch() from the DO blocks idling / pins the DO
 *     (anti-pattern #3) — token verification and upstream calls live in the
 *     stateless front Worker.
 *   - Legacy `server.accept()` defeats hibernation (anti-pattern #1) — only
 *     `ctx.acceptWebSocket()` (relevant from Phase 4 on).
 *
 * A dumb `grep -rn` CI step complements this (catches `globalThis.setTimeout`
 * evasion).
 */

import tseslint from "typescript-eslint";

export default [
	{
		ignores: ["node_modules/**", ".wrangler/**", "worker-configuration.d.ts"],
	},
	{
		files: ["src/**/*.ts", "test/**/*.ts", "canary/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
		},
	},
	{
		files: ["src/do/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
		},
		rules: {
			"no-restricted-globals": [
				"error",
				{
					name: "setTimeout",
					message:
						"setTimeout pins the Durable Object awake (anti-pattern #2). Use ctx.storage.setAlarm().",
				},
				{
					name: "setInterval",
					message:
						"setInterval pins the Durable Object awake (anti-pattern #2). Use ctx.storage.setAlarm().",
				},
			],
			"no-restricted-syntax": [
				"error",
				{
					selector: "CallExpression[callee.property.name='accept']",
					message:
						"Legacy server.accept() defeats hibernation (anti-pattern #1). Use ctx.acceptWebSocket().",
				},
				{
					selector: "CallExpression[callee.name='fetch']",
					message:
						"No outbound I/O from the Durable Object (anti-pattern #3). Verification and upstream calls live in the front Worker.",
				},
			],
		},
	},
];
