// A focus area's own icon: an image the owner uploaded, or one their agent drew when they asked. The icon's place on
// a focus line is the control: it opens Upload image, Generate, Generate with prompt… and Remove icon. A focus with
// no icon shows no picture, only a quiet outline when the line is pointed at.
import { useRef, useState } from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { ImagePlusIcon, PencilLineIcon, SparklesIcon, Trash2Icon, UploadIcon, type LucideIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import type { FocusArea } from '@/data'
import { useStore } from '@/store'
import { withLocalApiTokenQuery } from '../../../local-api-token-client'
import { FOCUS_ICON_PICKABLE, focusIconMenu, focusIconSrc, iconDirection, type FocusIconAction } from '@/live/focus-icon'
import { CANNOT_READ_IMAGE, drawFocusIcon } from '@/lib/draw-focus-icon'
import type { IconRunState } from '../../../../services/work-view/owner-runs.mjs'
import { MAX_FOCUS_ICON_DIRECTION_CHARS } from '../../../../services/work-view/focus-icon-limits.mjs'

const ICON_RUN_STATE: Record<IconRunState, string> = { generating: 'Generating…', failed: 'Icon not generated' }
const ICON_ACTION: Record<FocusIconAction, { label: string; icon: LucideIcon }> = {
  upload: { label: 'Upload image', icon: UploadIcon },
  generate: { label: 'Generate', icon: SparklesIcon },
  'generate-with-prompt': { label: 'Generate with prompt…', icon: PencilLineIcon },
  remove: { label: 'Remove icon', icon: Trash2Icon },
}

/** The icon as a small rounded square, decorative beside the focus name. Nothing when the area has none. */
export function FocusIcon({ area, className }: { area: Pick<FocusArea, 'id' | 'icon'>; className?: string }) {
  // An <img> cannot send the local API token header (#5141), so a worker URL carries ?token= when the page has one.
  const plain = focusIconSrc(area)
  const src = plain && !plain.startsWith('data:') ? withLocalApiTokenQuery(plain) : plain
  if (!src) return null
  return <img key={src} src={src} alt="" decoding="async" className={cn('size-[22px] shrink-0 rounded-md object-cover', className)} onError={(event) => { event.currentTarget.hidden = true }} />
}

export type FocusIconControl = ReturnType<typeof useFocusIconControl>

/** One focus's icon actions and what went wrong with the last one. Shared by the menu and the line that says the reason. */
export function useFocusIconControl(area: FocusArea) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const attempt = async (act: () => Promise<unknown>) => {
    setBusy(true)
    setProblem(null)
    try { await act() }
    catch (error) { setProblem(error instanceof Error ? (error.message === CANNOT_READ_IMAGE ? t(CANNOT_READ_IMAGE) : error.message) : String(error)) }
    finally { setBusy(false) }
  }
  const { setFocusIcon, generateFocusIcon } = useStore.getState()
  return {
    area, busy, problem,
    upload: (file: File) => attempt(async () => setFocusIcon(area.id, await drawFocusIcon(file))),
    remove: () => attempt(() => setFocusIcon(area.id, null)),
    /** One click, one run. `direction` is what the owner typed for it, if anything. */
    generate: (direction?: string) => attempt(async () => {
      const started = await generateFocusIcon(area.id, direction)
      if (started.outcome === 'refused') setProblem(started.reason)
    }),
  }
}

/** Why the last icon action did nothing, or why the last run drew none. Nothing while all is well: the slot itself shows a run in progress. */
export function FocusIconProblem({ control, className }: { control: FocusIconControl; className?: string }) {
  const { t } = useI18n()
  const run = control.area.iconRun
  const failed = run?.state === 'failed' ? (run.error ? `${t(ICON_RUN_STATE.failed)}: ${run.error}` : t(ICON_RUN_STATE.failed)) : null
  const reason = control.problem ?? failed
  return reason ? <p role="status" className={cn('text-xs text-attention-foreground', className)}>{reason}</p> : null
}

/**
 * The icon's place as a button with a menu. `line` is the slot on a focus line: empty at rest, a quiet outline when
 * the line is pointed at or holds the keyboard. `page` is the larger one where a focus has a page to itself.
 * "Generate with prompt…" swaps the menu for one field, where the owner says what to draw.
 */
export function FocusIconMenu({ control, size, className }: { control: FocusIconControl; size: 'line' | 'page'; className?: string }) {
  const { t } = useI18n()
  const { area } = control
  const picker = useRef<HTMLInputElement>(null)
  const slot = useRef<HTMLButtonElement>(null)
  const [prompting, setPrompting] = useState(false)
  const [direction, setDirection] = useState('')
  const generating = area.iconRun?.state === 'generating'
  const act: Record<FocusIconAction, () => void> = {
    upload: () => picker.current?.click(),
    generate: () => void control.generate(),
    'generate-with-prompt': () => { setDirection(''); setPrompting(true) },
    remove: () => void control.remove(),
  }
  const submit = () => {
    const sent = iconDirection(direction)
    if (!sent) return
    setPrompting(false)
    void control.generate(sent)
  }
  const label = generating ? t(ICON_RUN_STATE.generating) : t(area.icon ? 'Change icon' : 'Add icon')
  const side = size === 'line' ? 'size-[22px] rounded-md' : 'size-10 rounded-lg'
  return (
    <Req ids={['R19.17']}>
      <input ref={picker} type="file" accept={FOCUS_ICON_PICKABLE} hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void control.upload(file); event.target.value = '' }} />
      <PopoverPrimitive.Root open={prompting} onOpenChange={setPrompting}>
        <DropdownMenu>
          <PopoverPrimitive.Anchor asChild>
            <DropdownMenuTrigger asChild>
              <button ref={slot} type="button" disabled={control.busy} aria-label={label} title={label}
                className={cn('group/slot flex shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-accent',
                  size === 'line' ? 'size-11 md:size-7' : 'size-11', className)}>
                {generating ? <Spinner className={size === 'line' ? 'size-4' : 'size-5'} />
                  : area.icon ? <FocusIcon area={area} className={side} />
                  : <span aria-hidden="true" className={cn('flex items-center justify-center border border-dashed border-muted-foreground/60', side,
                      // A touch screen has no hover, so there the outline always shows.
                      size === 'line' && !prompting && 'opacity-0 transition-opacity group-hover/focus:opacity-100 group-focus-visible/slot:opacity-100 group-data-[state=open]/slot:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100')}>
                      <ImagePlusIcon className={size === 'line' ? 'size-3' : 'size-4'} />
                    </span>}
              </button>
            </DropdownMenuTrigger>
          </PopoverPrimitive.Anchor>
          {/* Opening the field must not hand the focus back to the slot first. */}
          <DropdownMenuContent align="start" className="w-auto min-w-52" onCloseAutoFocus={(event) => { if (prompting) event.preventDefault() }}>
            {focusIconMenu(area).map(({ action, disabled }) => {
              const { label: words, icon: Icon } = ICON_ACTION[action]
              return <DropdownMenuItem key={action} disabled={disabled} onSelect={act[action]}><Icon />{t(words)}</DropdownMenuItem>
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content align="start" sideOffset={4} collisionPadding={16} aria-label={t('Generate with prompt…')}
            onCloseAutoFocus={(event) => { event.preventDefault(); slot.current?.focus() }}
            className="z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-popover outline-none">
            <form className="flex items-center gap-1.5" onSubmit={(event) => { event.preventDefault(); submit() }}>
              <Input autoFocus value={direction} maxLength={MAX_FOCUS_ICON_DIRECTION_CHARS} onChange={(event) => setDirection(event.target.value)}
                aria-label={t('What should the icon show?')} placeholder={t('e.g. a paper airplane, warm colors')} autoComplete="off"
                // 16px on phones, so iOS does not zoom the page when the field takes focus.
                className="h-11 min-w-0 flex-1 text-base md:h-8 md:text-sm" />
              <Button type="submit" size="sm" className="h-11 shrink-0 md:h-8" disabled={!iconDirection(direction)}>{t('Generate')}</Button>
            </form>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </Req>
  )
}
