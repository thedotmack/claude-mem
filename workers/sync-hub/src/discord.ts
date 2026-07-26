/**
 * Shared Discord webhook posting — the ONE place that knows the wire shape
 * (payload = {embeds: [embed]}, copied from scripts/discord-release-notify.js).
 * Used by the hourly watchdog (src/watchdog.ts) and the 5-minute
 * control-plane probe (src/control-plane-probe.ts); extracted so the two
 * monitors cannot drift apart. The webhook URL is always the
 * DISCORD_WEBHOOK_URL secret binding — never hardcoded.
 *
 * Throws on any failure (network or non-2xx status): each caller decides
 * what a failed ping means for ITS state machine. Both current callers
 * swallow + log — an alert is a courtesy, never a load-bearing step.
 */

export interface DiscordEmbedField {
	name: string;
	value: string;
	inline: boolean;
}

export interface DiscordEmbed {
	title: string;
	description: string;
	color: number;
	fields: DiscordEmbedField[];
	footer: { text: string };
	timestamp: string;
}

export async function postDiscordEmbed(
	webhookUrl: string,
	embed: DiscordEmbed,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
	const res = await fetchImpl(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ embeds: [embed] }),
	});
	if (!res.ok) {
		const errorText = await res.text().catch(() => "");
		throw new Error(`Discord API error: ${res.status} - ${errorText.slice(0, 200)}`);
	}
}
