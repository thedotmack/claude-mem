---
name: social-media-agent
description: Plan, draft, review, and publish social media posts (Facebook, Instagram, and similar platforms) with an approval gate before anything goes live. Use when asked to run a social media agent, schedule posts, or manage content for connected social accounts.
---

# Social Media Agent

Orchestrate a content pipeline for social platforms without assuming a specific publishing tool. The account connection (Composio, a direct Meta Graph API integration, Buffer, etc.) is whatever the user has authorized — this skill covers the workflow around it, not the transport.

## When to Use

- "Post this to Instagram/Facebook"
- "Run the social media agent for this week"
- "Draft next week's posts"
- "Check how the last post performed"

## Prerequisites

Before doing anything, confirm a publishing tool is actually connected:

- **Composio** (or another MCP connector with Facebook/Instagram tools) — check `ToolSearch` for `mcp__Composio__*` or similar. If none exist, the account is not connected yet.
- If nothing is connected, tell the user which connector needs authorizing (via claude.ai connector settings, or `/mcp` in an interactive session) and stop. Do not invent API calls or pretend a post went out.

## Workflow

1. **Plan** — Confirm goal, platforms, cadence, and voice/tone. Reuse the account's established style rather than inventing a new one each time.
2. **Draft** — Write the copy (and describe/generate any image if requested). Keep platform differences in mind: Instagram captions tolerate hashtags and longer text; Facebook favors shorter, link-friendly copy.
3. **Approval gate** — Show the full draft (text + media description + target platform + scheduled time) and get explicit user confirmation before publishing. Treat "run autonomously" as authorization for the *pipeline* (drafting, scheduling, monitoring), not as blanket authorization to skip this gate on every single post — confirm once per batch/session what the user wants approved automatically vs. reviewed.
4. **Publish** — Call the connected tool. Verify the response actually indicates success (post ID, URL); don't report success on an ambiguous or error response.
5. **Log** — Record what was posted, when, and to which account. If claude-mem is active, this becomes a normal observation and is recoverable later via `/mem-search` (e.g., "what did we post about X last month").
6. **Monitor** — When asked to check performance, pull engagement metrics from the connected tool and summarize; don't estimate numbers you didn't fetch.

## Autonomous Operation

For truly recurring, unattended runs (e.g., "post something every day"):

- Use the `/loop` skill or a scheduled trigger (`create_trigger`) to fire this workflow on a cadence.
- Autonomous mode still means step 3 happens — either the user pre-approved a content calendar in full (all drafts reviewed up front), or the agent posts and immediately reports what went out so the user can catch problems fast. Never skip the gate silently just because the run is unattended.
- Rate-limit yourself to the cadence the user specified. Don't burst-publish to "catch up" after a gap without checking in first.

## Guardrails

- Never publish content containing anything wrapped in `<private>` tags — strip it, same as the rest of claude-mem (see `src/utils/tag-stripping.ts`).
- Don't post financial, medical, legal, or other high-stakes claims on the user's behalf without explicit sign-off, even in autonomous mode.
- If a platform API returns a policy/moderation error, surface it verbatim — don't retry with altered content to force it through.
