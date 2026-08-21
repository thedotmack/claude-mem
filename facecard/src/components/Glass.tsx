import type { ReactNode } from "react";

export function Glass({
  children,
  className = "",
  quiet = false,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  quiet?: boolean;
  as?: "div" | "section" | "article" | "aside";
}) {
  return <Tag className={`${quiet ? "glass-quiet" : "glass"} ${className}`}>{children}</Tag>;
}

export function Kicker({ children }: { children: ReactNode }) {
  return <p className="kicker">{children}</p>;
}

/** Primary action — a glass slab that presses like a physical key. */
export function GlassButton({
  children,
  onClick,
  href,
  disabled,
  tone = "default",
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  tone?: "default" | "gold";
  className?: string;
  type?: "button" | "submit";
}) {
  const base =
    "choice-card glass inline-flex items-center justify-center gap-2 px-7 py-4 text-[0.82rem] font-semibold tracking-[0.16em] uppercase disabled:opacity-40 disabled:pointer-events-none";
  const toneClass =
    tone === "gold"
      ? "text-[#0B0906] [background:linear-gradient(157deg,rgba(216,176,114,.96),rgba(196,152,88,.86))] border-[rgba(216,176,114,.5)]"
      : "text-[color:var(--color-paper)]";

  if (href) {
    return (
      <a href={href} className={`${base} ${toneClass} ${className}`}>
        {children}
      </a>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${toneClass} ${className}`}>
      {children}
    </button>
  );
}
