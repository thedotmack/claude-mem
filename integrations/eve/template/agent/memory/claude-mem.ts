import { claudeMem } from "claude-mem/eve";
import { defineMemory } from "eve/memory";
import { isScheduleAuth } from "eve/schedules";

// This is a personal agent: claude-mem memory belongs to the owner of
// CLAUDE_MEM_API_KEY, so the slot is on only for the owner and off for
// everyone else (no recall, no memory tools).
const OWNER_SCOPE = "owner";

// An email address (or an Apple ID, which is one) must match exactly, ignoring
// only case and surrounding spaces. jane.doe@x and janedoe@x are different
// accounts, so punctuation is never stripped from one.
function sameEmail(a: string | undefined, b: string | undefined) {
  const normalize = (value: string) => value.trim().toLowerCase();
  return Boolean(a && b && normalize(a) && normalize(a) === normalize(b));
}

// An iMessage handle is a phone number or an Apple ID. A phone number ignores
// spaces, dots, dashes and parentheses (+1 (555) 010-0199 is +15550100199); a
// handle with "@" is an Apple ID and is compared as an email.
function sameIMessageHandle(a: string | undefined, b: string | undefined) {
  if (!a || !b) return false;
  if (a.includes("@") || b.includes("@")) return sameEmail(a, b);
  const normalize = (value: string) => value.replace(/[\s().-]/g, "");
  return Boolean(normalize(a) && normalize(a) === normalize(b));
}

export default defineMemory({
  description:
    "The owner's claude-mem memory: past work, decisions, and preferences from Claude Code, Codex, and other agents.",
  provider: claudeMem({
    apiKey: process.env.CLAUDE_MEM_API_KEY,
    // Saves from this agent land in one project; recall reads the owner's
    // whole memory. Safe only because scope below admits the owner alone.
    project: process.env.CLAUDE_MEM_PROJECT || "eve-agent",
    searchAllProjects: true,
  }),
  scope(context) {
    const caller = context.session.auth.current;
    if (!caller) return null;

    // `eve dev` and `next dev` on your own machine.
    if (caller.principalType === "local-dev") return OWNER_SCOPE;

    // Your own schedules in agent/schedules/ run as eve's app principal.
    // Only code in this project can start them, so they get your memory.
    if (isScheduleAuth(caller)) return OWNER_SCOPE;
    if (caller.principalType !== "user") return null;

    // Starter mode: whoever knows EVE_CHAT_PASSWORD is the owner.
    if (caller.authenticator === "password") return OWNER_SCOPE;

    // Production mode (Sign in with Vercel): only the owner's account.
    if (caller.authenticator === "better-auth") {
      const email = typeof caller.attributes.email === "string" ? caller.attributes.email : undefined;
      return sameEmail(email, process.env.CLAUDE_MEM_OWNER_EMAIL) ? OWNER_SCOPE : null;
    }

    // iMessage (`eve add channel/linq` or `eve add channel/photon`): only texts
    // from the owner's own phone number or Apple ID.
    if (caller.issuer === "linq" || caller.issuer === "photon") {
      return sameIMessageHandle(caller.subject, process.env.CLAUDE_MEM_OWNER_PHONE) ? OWNER_SCOPE : null;
    }

    return null;
  },
});
