// Codex's panels (design.css `.panel`, `.panel h2`, `.split`), shared by Workspace and Machine and sync (design pass
// Phase 4) and Requests' By agent (Phase 5): paper on the page with a hairline edge and its shadow, its heading inside,
// and two of them side by side from 768px.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A panel's look: paper with a hairline edge and its shadow. By agent's open agent is one that opens and closes. */
export const PANEL_SURFACE_CLASS_NAME = 'rounded-2xl border border-border bg-card shadow-panel'
/** A panel heading's size, on a phone and from 768px. */
export const PANEL_TITLE_CLASS_NAME = 'text-panel-title-phone md:text-panel-title'

/** A panel's heading. */
export function PanelTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn('mb-2', PANEL_TITLE_CLASS_NAME, className)}>{children}</h2>
}

/** One panel: 18px in on a phone, 24px by 28px from 768px. `title`: its heading, when nothing sits above it. */
export function Panel({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn(PANEL_SURFACE_CLASS_NAME, 'px-4.5 py-4.5 md:px-7 md:py-6', className)}>
      {title && <PanelTitle>{title}</PanelTitle>}
      {children}
    </section>
  )
}

/** Two panels: stacked on a phone, side by side from 768px (the `panels` columns in index.css). */
export function PanelPair({ children }: { children: ReactNode }) {
  return <div className="grid items-start gap-3 md:grid-cols-panels md:gap-7">{children}</div>
}
