// The owner's own grouping of focuses (a Project on the page, an initiative in the code), edited where it shows: a
// heading renamed in place or merged into another, and a focus line's menu that files the focus under another heading
// or under none. All save the same owner change (set-initiative), so the saved note's Undo covers them.
import { useState } from 'react'
import { GripVerticalIcon, ListTreeIcon, MoreHorizontalIcon } from 'lucide-react'
import { motion, useDragControls } from 'motion/react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import type { FocusArea } from '@/data'
import { INITIATIVE_WORDS } from '@/live/initiative-words'
import { moveToInitiative, renameInitiative, type InitiativeSection } from '@/live/thread-groups'
import { MAX_FOCUS_INITIATIVE_CHARS, initiativeKey } from '../../../../services/work-view/focus-initiative-names.mjs'
import type { FocusChanges } from './focus-changes'

/** A heading carried by its grip, as its section hears of it: where the pointer is (page coordinates), then that it was let go. */
export interface HeadingCarry { onStart: () => void; onMove: (point: { x: number; y: number }) => void; onEnd: () => void }

const QUIET_UNTIL_USED = 'opacity-0 transition-opacity group-focus-within/heading:opacity-100 group-hover/heading:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100'
const GRIP = '-mx-1 flex h-11 w-5 shrink-0 items-center justify-center text-muted-foreground/70 md:h-7'

/**
 * A section's heading: its name, a quiet word while the name is only a guess, and how many focuses it holds. A click
 * on the name edits it in place: Enter files every focus under the new name (into the project that already has
 * it, when one does), Escape or leaving the field keeps the old one. A project is merged into another by dragging
 * its grip onto that project's section, or from its menu (`mergeInto`), which needs no drag.
 */
export function InitiativeHeading({ section, changes, others, carry, onMergeInto }: { section: InitiativeSection; changes: FocusChanges; others: readonly InitiativeChoice[]; carry: HeadingCarry; onMergeInto: (name: string) => void }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<string | null>(null)
  const [carried, setCarried] = useState(false)
  const controls = useDragControls()
  const name = section.kind === 'initiative' ? section.initiative : t(INITIATIVE_WORDS.none)
  const mergeable = section.kind === 'initiative' && others.length > 0
  const save = async () => {
    const change = draft === null ? null : renameInitiative(section, draft)
    if (!change || await changes.apply(change, section.kind === 'initiative' ? { heading: section.initiative } : {})) setDraft(null)
  }
  const startCarry = (event: React.PointerEvent) => {
    if (changes.saving) return
    // Otherwise the drag selects the text it passes over.
    event.preventDefault()
    controls.start(event)
  }
  return (
    <Req ids={['R19.19']}>
      <motion.h2 drag dragListener={false} dragControls={controls} dragSnapToOrigin dragMomentum={false}
        onDragStart={() => { setCarried(true); carry.onStart() }} onDrag={(_event, info) => carry.onMove(info.point)} onDragEnd={() => { setCarried(false); carry.onEnd() }}
        className={cn('group/heading relative flex min-h-11 items-center gap-2 px-2 text-xs font-medium text-muted-foreground md:min-h-7', carried && 'z-20 rounded-md bg-background shadow-md')}>
        {mergeable
          ? <button type="button" data-heading-grip={section.key} aria-hidden="true" tabIndex={-1} title={t(INITIATIVE_WORDS.drag)} onPointerDown={startCarry}
              className={cn(GRIP, 'cursor-grab touch-none rounded-sm select-none active:cursor-grabbing', QUIET_UNTIL_USED)}><GripVerticalIcon className="size-4" /></button>
          : <span aria-hidden="true" className={GRIP} />}
        {draft !== null ? (
          <Input autoFocus value={draft} maxLength={MAX_FOCUS_INITIATIVE_CHARS} aria-label={t('Name')} disabled={changes.saving} onFocus={(event) => event.target.select()}
            onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (!changes.saving) setDraft(null) }}
            onKeyDown={(event) => { if (event.key === 'Enter') void save(); else if (event.key === 'Escape') setDraft(null) }}
            className="-ml-2 h-9 max-w-xs px-2 text-sm md:h-7 md:text-xs" />
        ) : (
          <>
            <button type="button" title={t(section.kind === 'initiative' ? 'Rename' : INITIATIVE_WORDS.add)} aria-label={section.kind === 'initiative' ? interpolate(t('Rename {name}'), { name }) : `${name}: ${t(INITIATIVE_WORDS.add)}`} onClick={() => setDraft(section.kind === 'initiative' ? section.initiative : '')}
              className="min-w-0 truncate rounded-sm text-left hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">{name}</button>
            {section.kind === 'initiative' && section.guess && <span className="font-normal text-muted-foreground/70">{t(INITIATIVE_WORDS.guess)}</span>}
          </>
        )}
        <span className="tabular-nums" title={interpolate(t(section.groups.length === 1 ? '{count} focus' : '{count} focuses'), { count: section.groups.length })}>{section.groups.length}</span>
        {mergeable && draft === null && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" disabled={changes.saving} aria-label={interpolate(t(INITIATIVE_WORDS.actions), { name })} className={cn('size-11 shrink-0 p-0 text-muted-foreground data-[state=open]:opacity-100 md:size-7', QUIET_UNTIL_USED)}><MoreHorizontalIcon /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" collisionPadding={8} className="min-w-44">
              <DropdownMenuItem onSelect={() => setDraft(section.initiative)}>{t('Rename')}</DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>{t(INITIATIVE_WORDS.mergeInto)}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent collisionPadding={8} className="max-h-72 overflow-y-auto">
                  {others.map((other) => <DropdownMenuItem key={other.key} onSelect={() => onMergeInto(other.name)}>{other.name}</DropdownMenuItem>)}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </motion.h2>
    </Req>
  )
}

/** The headings a focus can be filed under, as the list shows them. */
export interface InitiativeChoice { key: string; name: string }

/** Files one focus under another heading without dragging it: an existing one, a new one named here, or none. */
export function InitiativeMenu({ area, choices, changes, className }: { area: FocusArea; choices: readonly InitiativeChoice[]; changes: FocusChanges; className?: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const move = (initiative: string | null) => {
    const change = moveToInitiative(area, initiative)
    setOpen(false)
    if (change) void changes.apply(change)
  }
  return (
    <Req ids={['R19.19']}>
      <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (!next) setDraft(null) }}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={changes.saving} title={t(INITIATIVE_WORDS.move)} aria-label={`${t(INITIATIVE_WORDS.move)}: ${area.name}`} className={cn('size-11 shrink-0 p-0 text-muted-foreground data-[state=open]:opacity-100 md:size-7', className)}><ListTreeIcon /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" collisionPadding={8} className="min-w-52">
          {draft === null ? (
            <>
              <DropdownMenuLabel>{t(INITIATIVE_WORDS.move)}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={initiativeKey(area.initiative)} onValueChange={(key) => move(choices.find((choice) => choice.key === key)?.name ?? null)}>
                {choices.map((choice) => <DropdownMenuRadioItem key={choice.key} value={choice.key}>{choice.name}</DropdownMenuRadioItem>)}
                {/* None is a filing like any other: it takes a focus off its folder guess too, and stays. */}
                <DropdownMenuRadioItem value="">{t(INITIATIVE_WORDS.none)}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              {/* Stays open: the name is typed in the menu's own place. */}
              <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setDraft('') }}>{t(INITIATIVE_WORDS.add)}</DropdownMenuItem>
            </>
          ) : (
            <form className="flex items-center gap-1 p-1" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) move(draft) }}>
              {/* The menu reads typed letters as a jump to an item; only Escape is its to handle. */}
              <Input autoFocus value={draft} maxLength={MAX_FOCUS_INITIATIVE_CHARS} aria-label={t(INITIATIVE_WORDS.add)} placeholder={t('Name')}
                onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation() }} className="h-11 md:h-8" />
              <Button type="submit" variant="outline" size="sm" className="h-11 shrink-0 md:h-8" disabled={!draft.trim()}>{t('Save')}</Button>
            </form>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </Req>
  )
}
