// Codex's panels (design.css `.panel`, `.panel h2`, `.split`), shared by Workspace and Machine and sync (design pass
// Phase 4): paper on the page with a hairline edge and its shadow, its heading inside, and two of them side by side
// from 768px.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A panel's heading. */
export function PanelTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn('mb-2 text-panel-title-phone md:text-panel-title', className)}>{children}</h2>
}

/** One panel: 18px in on a phone, 24px by 28px from 768px. `title`: its heading, when nothing sits above it. */
export function Panel({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-2xl border border-border bg-card px-4.5 py-4.5 shadow-panel md:px-7 md:py-6', className)}>
      {title && <PanelTitle>{title}</PanelTitle>}
      {children}
    </section>
  )
}

/** Two panels: stacked on a phone, side by side from 768px (the `panels` columns in index.css). */
export function PanelPair({ children }: { children: ReactNode }) {
  return <div className="grid items-start gap-3 md:grid-cols-panels md:gap-7">{children}</div>
}
