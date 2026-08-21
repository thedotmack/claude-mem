const TABS = [
  { key: "feed", label: "Feed", href: "/feed" },
  { key: "create", label: "Create", href: "/create" },
  { key: "me", label: "Me", href: "/me" },
];

export default function NavBar({ active, signedIn }: { active: string; signedIn: boolean }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[max(0.9rem,env(safe-area-inset-bottom))]">
      <div className="glass flex items-center gap-1 px-2 py-2">
        {TABS.map((t) => (
          <a
            key={t.key}
            href={signedIn ? t.href : "/login"}
            className="rounded-2xl px-5 py-2.5 text-[0.7rem] font-semibold uppercase tracking-[0.16em] transition-colors"
            style={{
              color: active === t.key ? "var(--color-gold)" : "var(--color-muted)",
              background: active === t.key ? "rgba(255,255,255,.07)" : "transparent",
            }}
          >
            {t.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
