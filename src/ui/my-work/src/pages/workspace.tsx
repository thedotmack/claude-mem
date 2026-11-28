// Workspace (`?view=workspace`; design pass Phase 4, Codex D13): the page the bar's "…" opens, in place of its menu.
// Appearance (theme, language, focus area artwork), this computer (Machine and sync, the memory viewer and its
// settings), then tools and support (Team view, help and feedback, developer options, and on the cloud viewer Account &
// billing). Each choice opens under its own row, one at a time, so every language and theme are never shown at once
// (the phone's menu listed them all and ran under the bottom bar). The star count and the team plan promotion that sat
// in the menu are gone; the team plan stays under Team view. It reads no work model, so it opens on the loading and
// failed screens too (App.tsx WorkspaceBeforeLoad): what it says about the work waits until the work has loaded.
import { useId, useState, type ReactNode } from 'react'
import {
  ChevronRightIcon, CodeXmlIcon, CreditCardIcon, ExternalLinkIcon, ImageIcon, LanguagesIcon, LibraryIcon, LifeBuoyIcon,
  MonitorIcon, MoonIcon, SettingsIcon, SunIcon, SunMoonIcon, UsersIcon, type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { pageHeading } from '@/components/app-bar'
import { CLAUDE_MEM_REPO_URL, MY_WORK_FEEDBACK_URL, type Translate } from '@/components/bits'
import { Panel, PanelPair } from '@/components/panel'
import { interpolate, LOCALE_NAMES, LOCALES, useI18n } from '@/lib/i18n'
import { placeLinkPress, usePageHref } from '@/lib/place-link'
import { isThemeChoice, THEME_CHOICES, type ThemeChoice } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { isServedFromCloud } from '@/live/served-from'
import { useStore, useWorkspace, type FocusArtwork } from '@/store'
import { themeChoiceInUse } from '@/store/slices/view-slice'
import { TEAMBRAIN_START_URL } from '../../../viewer/constants/promo'
import { MEMORY_PLACE, MEMORY_SETTINGS_ADDRESS } from '../../../app-places'

/** Each theme choice's words and mark. "Light mode", not "Light": the catalogs already give "Light" another meaning. */
const THEME_CHOICE_LOOK: Record<ThemeChoice, { words: (t: Translate) => string; icon: LucideIcon }> = {
  system: { words: (t) => t('System'), icon: MonitorIcon },
  light: { words: (t) => t('Light mode'), icon: SunIcon },
  dark: { words: (t) => t('Dark mode'), icon: MoonIcon },
}

/** The focus area artwork choice's words, in the order it shows them (it moved here from the home page's board). */
const ARTWORK_WORDS: Record<FocusArtwork, (t: Translate) => string> = {
  full: (t) => t('Full'),
  compact: (t) => t('Compact'),
  off: (t) => t('Off'),
}
const ARTWORK_CHOICES = Object.keys(ARTWORK_WORDS) as FocusArtwork[]

/** The rows that open under themselves, at most one at a time. The one definition: the page keeps which is open. */
const WORKSPACE_CHOICES = ['theme', 'language', 'artwork', 'team', 'help', 'developer'] as const
type WorkspaceChoice = (typeof WORKSPACE_CHOICES)[number]

/** Billing, cancel, card and synced devices live on cmem.ai; cloud viewer accounts land here and have no other way there. */
const ACCOUNT_AND_BILLING_URL = 'https://cmem.ai/account'
const DOCUMENTATION_URL = 'https://docs.claude-mem.ai'

/** A row's mark in its quiet square (Codex's `.sketch-icon`). */
function RowMark({ icon: Icon }: { icon: LucideIcon }) {
  return <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-5" /></span>
}

/** A row's words: its name, and under it a quiet line when it has one (Codex's `.rowtitle` and `.rowmeta`). */
function RowWords({ title, meta }: { title: string; meta?: string | null }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block text-row-title">{title}</span>
      {meta && <span className="mt-0.5 block text-sm font-normal text-muted-foreground">{meta}</span>}
    </span>
  )
}

/** Codex's list row: the whole row is the control (no box of its own: the Button's edge is off), a hairline between rows. */
const ROW_CLASS_NAME = 'flex min-h-16 w-full items-center gap-4 rounded-md border-0 px-1 py-3 text-left hover-enabled:bg-muted'

/** A row that opens its choice under itself: a disclosure button, its value at the right, its arrow turning down. */
function ChoiceRow({ icon, title, meta, value, open, onToggle, children }: {
  icon: LucideIcon; title: string; meta?: string | null; value?: string; open: boolean; onToggle: () => void; children: ReactNode
}) {
  const panelId = useId()
  return (
    <div data-workspace-row="" className="border-b border-border last:border-b-0">
      {/* The choice is drawn only while open, so the row names it as what it controls only then. */}
      <Button variant="bare" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle} className={ROW_CLASS_NAME}>
        <RowMark icon={icon} />
        <RowWords title={title} meta={meta} />
        {value && <span className="shrink-0 text-sm font-normal text-muted-foreground">{value}</span>}
        <ChevronRightIcon aria-hidden="true" className={cn('size-4.5 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
      </Button>
      {open && <div id={panelId} className="pb-4 pl-14">{children}</div>}
    </div>
  )
}

/** A row that goes somewhere: a page of My Work (moved to in the page), Memory, or another site (marked as one). */
function LinkRow({ icon, title, meta, href, onPress, external = false }: {
  icon: LucideIcon; title: string; meta?: string | null; href: string; onPress?: () => void; external?: boolean
}) {
  return (
    <Button asChild variant="bare" className={cn(ROW_CLASS_NAME, 'rounded-none border-b border-border last:border-b-0')}>
      <a href={href} onClick={onPress ? placeLinkPress(onPress) : undefined} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>
        <RowMark icon={icon} />
        <RowWords title={title} meta={meta} />
        {external ? <ExternalLinkIcon aria-hidden="true" className="size-4 text-muted-foreground" /> : <ChevronRightIcon aria-hidden="true" className="size-4.5 text-muted-foreground" />}
      </a>
    </Button>
  )
}

/** A link inside an opened row (Help and feedback, the team plan): another site, so it says so. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="link" size="sm" className="h-auto justify-start px-0">
      <a href={href} target="_blank" rel="noreferrer">{children}<ExternalLinkIcon aria-hidden="true" /></a>
    </Button>
  )
}

export function Workspace() {
  const { t, locale, setLocale } = useI18n()
  const { team } = useWorkspace()
  // How many people the board shows, and the live feed's state, once the work has loaded; before that the page draws
  // without them (it opens on the loading and failed screens too).
  const peopleCount = useStore((state) => state.work.load.state === 'loaded' ? state.work.load.model.people.length : null)
  const feedLabel = useStore((state) => state.work.connection?.label ?? null)
  const sample = useStore((state) => state.work.sourceKind === 'sample')
  const theme = useStore((state) => themeChoiceInUse(state.view))
  const showSpec = useStore((state) => state.view.showSpec)
  const artwork = useStore((state) => state.view.focusArtwork)
  const { setTheme, setShowSpec, setWorkspace, setFocusArtwork, goToPage } = useStore.getState()
  const machineHref = usePageHref('machine')
  const [open, setOpen] = useState<WorkspaceChoice | null>(null)
  const toggle = (choice: WorkspaceChoice) => () => setOpen((current) => current === choice ? null : choice)
  const cloud = isServedFromCloud(window.location.hostname)
  const chooseTheme = (value: string) => {
    if (!value) return
    if (!isThemeChoice(value)) throw new Error(`Unknown theme choice ${value}`)
    setTheme(value)
  }
  const chooseLocale = (value: string) => {
    if (!value) return
    const chosen = LOCALES.find((code) => code === value)
    if (!chosen) throw new Error(`Unknown language ${value}`)
    setLocale(chosen)
  }
  const chooseArtwork = (value: string) => {
    const chosen = ARTWORK_CHOICES.find((choice) => choice === value)
    if (chosen) setFocusArtwork(chosen)
  }
  // Team view on with one person says so (c-shell-team-switch M); off, it says what it shows.
  const teamHint = !team ? t('See everyone’s requests on one board, with who asked and where work collides.')
    : peopleCount === null ? null
      : interpolate(t(peopleCount === 1 ? '{count} person on this board' : '{count} people on this board'), { count: peopleCount })
  // Machine and sync's quiet line: the live feed's state (the sample's feed is a demonstration, so it says so).
  const machineMeta = sample ? t('Sample data · not your work') : feedLabel && t(feedLabel)
  return (
    <div className="space-y-8 md:space-y-9">
      <PanelPair>
        <Panel title={t('Appearance')}>
          <ChoiceRow icon={SunMoonIcon} title={t('Theme')} value={THEME_CHOICE_LOOK[theme].words(t)} open={open === 'theme'} onToggle={toggle('theme')}>
            <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={theme} onValueChange={chooseTheme} aria-label={t('Theme')}>
              {THEME_CHOICES.map((choice) => {
                const { words, icon: Icon } = THEME_CHOICE_LOOK[choice]
                return <ToggleGroupItem key={choice} value={choice} data-theme-choice={choice} className="gap-1.5 px-3"><Icon aria-hidden="true" />{words(t)}</ToggleGroupItem>
              })}
            </ToggleGroup>
          </ChoiceRow>
          <ChoiceRow icon={LanguagesIcon} title={t('Language')} value={LOCALE_NAMES[locale]} open={open === 'language'} onToggle={toggle('language')}>
            <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={locale} onValueChange={chooseLocale} aria-label={t('Language')}>
              {LOCALES.map((code) => <ToggleGroupItem key={code} value={code} lang={code} className="px-3">{LOCALE_NAMES[code]}</ToggleGroupItem>)}
            </ToggleGroup>
          </ChoiceRow>
          <ChoiceRow icon={ImageIcon} title={t('Focus area artwork')} value={ARTWORK_WORDS[artwork](t)} open={open === 'artwork'} onToggle={toggle('artwork')}>
            {/* Display only: a change never asks for a picture to be made. */}
            <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={artwork} onValueChange={chooseArtwork} aria-label={t('Focus area artwork')}>
              {ARTWORK_CHOICES.map((choice) => <ToggleGroupItem key={choice} value={choice} className="px-3">{ARTWORK_WORDS[choice](t)}</ToggleGroupItem>)}
            </ToggleGroup>
          </ChoiceRow>
        </Panel>
        {/* Named as Machine and sync names the same panel: the cloud viewer reads no computer of the person's. */}
        <Panel title={cloud ? t('Cloud viewer') : t('This computer')}>
          <LinkRow icon={MonitorIcon} title={pageHeading('machine', t)} meta={machineMeta} href={machineHref} onPress={() => goToPage('machine')} />
          <LinkRow icon={LibraryIcon} title={t('Memory viewer')} meta={t('Timeline and sessions')} href={MEMORY_PLACE.address} />
          <LinkRow icon={SettingsIcon} title={t('Memory settings')} href={MEMORY_SETTINGS_ADDRESS} />
        </Panel>
      </PanelPair>
      <section>
        <h2 className="mb-3 text-section-title-phone md:mb-4 md:text-section-title">{t('Tools and support')}</h2>
        <div className="border-t border-border">
          <Req ids={['R9.1', 'R9.4']}>
            <ChoiceRow icon={UsersIcon} title={t('Team view')} meta={t('Team board and plan')} open={open === 'team'} onToggle={toggle('team')}>
              <div className="space-y-3">
                <Label className="flex items-start gap-3 font-normal">
                  <Switch checked={team} onCheckedChange={(checked) => setWorkspace({ team: checked })} />
                  <span className="space-y-0.5"><span className="block font-medium">{t('Team view')}</span>{teamHint && <span className="block text-sm text-muted-foreground">{teamHint}</span>}</span>
                </Label>
                {!team && <ExternalLink href={TEAMBRAIN_START_URL}>{t('Start team plan')}</ExternalLink>}
              </div>
            </ChoiceRow>
          </Req>
          <ChoiceRow icon={LifeBuoyIcon} title={t('Help and feedback')} meta={t('Documentation, feedback and GitHub')} open={open === 'help'} onToggle={toggle('help')}>
            <div className="flex flex-col items-start gap-1">
              <ExternalLink href={DOCUMENTATION_URL}>{t('Documentation')}</ExternalLink>
              <ExternalLink href={MY_WORK_FEEDBACK_URL}>{t('Send feedback')}</ExternalLink>
              <ExternalLink href={CLAUDE_MEM_REPO_URL}>{t('claude-mem on GitHub')}</ExternalLink>
            </div>
          </ChoiceRow>
          <ChoiceRow icon={CodeXmlIcon} title={t('Developer options')} meta={t('Spec IDs on the page')} open={open === 'developer'} onToggle={toggle('developer')}>
            <Label className="flex items-center gap-3 font-normal">
              <Switch checked={showSpec} onCheckedChange={setShowSpec} />{t('Show spec IDs')}
            </Label>
          </ChoiceRow>
          {/* Cloud viewer only (R18.1); My Work served from this computer has no cmem.ai account to manage. */}
          {cloud && (
            <Req ids={['R18.1']}>
              <LinkRow icon={CreditCardIcon} title={t('Account & billing')} href={ACCOUNT_AND_BILLING_URL} external />
            </Req>
          )}
        </div>
      </section>
    </div>
  )
}
