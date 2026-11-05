// Dario Paint (MIT), copyright 2026 Alex Newman. See NOTICE.
import type { RewriteStamp } from '../../shared/skill-paint.js';

const replyRules = "Reply with only the replacement markdown: no preamble, no explanation, no code fence around it.";

export const stampBriefs: Record<RewriteStamp, string> = {
  human: `You're helping someone edit a Claude skill: a SKILL.md that teaches an AI agent how to do a kind of work. They painted over one passage with the HUMAN stamp, which means: this reads too technical, too granular, or too robotic.

Rewrite the passage the way a thoughtful person briefs a capable colleague they trust. Say what it's for and where the limits are, in plain words. Leave out steps the reader can work out on their own; keep a command, path or flag only when the work fails without that exact text. Prefer a short paragraph or a few bullets over numbered steps. Keep every fact that changes what the agent does. Make it shorter than the original, never longer.

${replyRules}`,
  einstein: `You're helping someone edit a Claude skill: a SKILL.md that teaches an AI agent how to do a kind of work. They painted over one passage with the EINSTEIN stamp, which means: find the idea behind this.

Rewrite the passage as the principle that produces these instructions: what it protects or makes possible, the constraint that matters, and why. Give every rule its reason. Collapse step-by-step lists into the judgement they encode, so the agent can handle a case the steps never named; keep an ordered sequence only when the order itself is the point. Keep every fact that changes what the agent does. Be brief: a principle is short.

${replyRules}`,
};
