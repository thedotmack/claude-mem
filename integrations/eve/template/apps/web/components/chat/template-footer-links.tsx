"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const EVE_URL = "https://vercel.com/eve";
const GITHUB_REPOSITORY_URL = "https://github.com/vercel/eve";
const GITHUB_URL = `${GITHUB_REPOSITORY_URL}/tree/main/apps/templates/eve-chat-template`;
const COPY_PROMPT = `You are helping me bootstrap and deploy my own eve chat agent from the Vercel eve chat template.

Source template:
${GITHUB_URL}

Goal:
Fork or clone the template into a new project, customize the agent if I ask, verify it locally, and deploy the database-free starter to Vercel.

Use the repository README, docs/setup-and-deploy.md, and scripts/setup.sh as the source of truth. Prefer the one-shot setup script when possible:

1. Confirm prerequisites: Node.js 24+, pnpm/Corepack, Vercel CLI, a Vercel account/team, and authentication with vercel login.
2. Create/fork/clone the eve-chat-template subtree from vercel/eve.
3. Install dependencies with pnpm install.
4. Link the Vercel project with vercel link, using --scope <team-slug> if I provide one.
5. Generate a strong EVE_CHAT_PASSWORD (16+ characters recommended) and add it to local and Vercel environments without printing it.
6. Start the app locally with pnpm dev and verify the chat page loads, password sign-in works, sending a message creates a chat, and refreshing restores it from browser storage.
7. Deploy to Vercel. Do not provision Neon, Upstash, a Vercel OAuth app, or run migrations unless I explicitly ask to upgrade to production persistence.
8. Report the local URL, production URL, any dashboard steps I still need to complete, and any files you changed.

Do not print secrets in the final answer. Ask before deleting or overwriting any existing project files.`;
const DEPLOY_ENV_VARS = ["EVE_CHAT_PASSWORD"] as const;
const DEPLOY_URL = (() => {
  const params = new URLSearchParams([
    [
      "demo-description",
      "A persisted Next.js chat template for eve, built with shadcn/ui, Tailwind CSS, Streamdown, Better Auth, Drizzle, and Neon.",
    ],
    [
      "demo-image",
      "https://images.ctfassets.net/e5382hct74si/YXYTquqpBmvVFbASdIvrC/bb50d21ba7866882d90e25d842b6fc02/eve-chat-no-bg.png",
    ],
    ["demo-title", "eve Chat Template"],
    ["demo-url", "https://chat.eve.dev"],
    ["env", DEPLOY_ENV_VARS.join(",")],
    [
      "envDescription",
      "Choose a strong password to protect your agent (16+ characters recommended).",
    ],
    [
      "envLink",
      `${GITHUB_REPOSITORY_URL}/blob/main/apps/templates/eve-chat-template/docs/setup-and-deploy.md`,
    ],
    ["from", "templates"],
    ["project-name", "eve Chat Template"],
    ["repository-name", "eve-chat-template"],
    ["repository-url", GITHUB_URL],
  ]);

  return `https://vercel.com/new/clone?${params.toString()}`;
})();

async function copyTextToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.inset = "0 auto auto 0";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.select();

    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      document.body.removeChild(textArea);
    }
  }
}

export function TemplateFooterLinks() {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current === null) {
      return;
    }

    window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
  }, []);

  const handleCopyPrompt = useCallback(async () => {
    clearResetTimer();
    setCopied(true);
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null;
      setCopied(false);
    }, 1600);

    await copyTextToClipboard(COPY_PROMPT);
  }, [clearResetTimer]);

  useEffect(() => clearResetTimer, [clearResetTimer]);

  return (
    <footer className="flex shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 px-2 text-center text-[11px] leading-4 text-muted-foreground/50 sm:text-xs">
      <span>
        Build your own chat agent with <FooterLink href={EVE_URL}>eve</FooterLink>:
      </span>
      <span>
        <FooterLink href={GITHUB_URL}>GitHub</FooterLink>,
      </span>
      <span>
        <FooterLink href={DEPLOY_URL}>Deploy</FooterLink>
      </span>
      <button
        aria-label={copied ? "Copied setup prompt" : "Copy setup prompt"}
        className={cn(
          "inline-grid cursor-pointer appearance-none grid-cols-[0.75rem_auto] items-center gap-1 rounded-sm border border-border/40 bg-transparent px-1.5 py-0.5 text-[inherit] leading-[inherit] font-[inherit] text-muted-foreground/60 transition-colors hover:border-border/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
          copied && "border-foreground/25 text-foreground",
        )}
        onClick={handleCopyPrompt}
        title={copied ? "Copied" : "Copy setup prompt"}
        type="button"
      >
        {copied ? (
          <CheckIcon className="col-start-1 row-start-1 size-3" />
        ) : (
          <CopyIcon className="col-start-1 row-start-1 size-3" />
        )}
        <span aria-hidden className="invisible col-start-2 row-start-1">
          Copy Prompt
        </span>
        <span className="col-start-2 row-start-1">{copied ? "Copied!" : "Copy Prompt"}</span>
      </button>
    </footer>
  );
}

function FooterLink({ children, href }: { readonly children: ReactNode; readonly href: string }) {
  return (
    <a
      className="underline underline-offset-4 transition-colors hover:text-foreground"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}
