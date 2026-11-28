// The bar's one "…" menu (decision G6): everything the bar does not show, one click away at every width.
// Team view, Language, Theme, Memory where the bar has no room for it, Account & billing on the cloud viewer, Feedback,
// Star on GitHub, and a Developer group. It reads no work model, so the bar draws it on the loading and failed screens
// too (design pass Phase 3).
import { useId, useState, type ReactNode } from 'react'
import { CreditCardIcon, ExternalLinkIcon, GlobeIcon, LibraryIcon, MessageSquareIcon, MonitorIcon, MoonIcon, MoreHorizontalIcon, StarIcon, SunIcon, UsersIcon, type LucideIcon } from 'lucide-react'
import { interpolate, LOCALE_NAMES, LOCALES, useI18n } from '@/lib/i18n'
import { isThemeChoice, THEME_CHOICES, type ThemeChoice } from '@/lib/theme'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuPortal, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Req } from '@/spec/req'
import { useStore, useWorkspace } from '@/store'
import { themeChoiceInUse } from '@/store/slices/view-slice'
import { TEAMBRAIN_START_URL } from '../../../viewer/constants/promo'
import { useGitHubStarCount } from '@/lib/use-github-star-count'
import { useMatchesMedia } from '@/lib/use-media'
import { isServedFromCloud } from '@/live/served-from'
import { MEMORY_PLACE } from '../../../app-places'
import { CLAUDE_MEM_REPO_URL, MY_WORK_FEEDBACK_URL, StarCount } from './bits'

/** Each theme choice's words and icon. "Light mode", not "Light": the catalogs already give "Light" another meaning. */
const THEME_CHOICE_LOOK: Record<ThemeChoice, { words: string; icon: LucideIcon }> = {
  system: { words: 'System', icon: MonitorIcon },
  light: { words: 'Light mode', icon: SunIcon },
  dark: { words: 'Dark mode', icon: MoonIcon },
}

/**
 * Where the Language choices open beside the menu: from Tailwind's sm breakpoint (640px) up. Narrower, the 288px menu
 * sits at the screen's right edge with under 100px left of it, so a side menu was cut off (it opened 18px past the left
 * edge at 390); there the choices are rows of the menu itself, as Theme's are.
 */
const LANGUAGE_SUBMENU_FITS = '(min-width: 640px)'

/** A menu row that opens another site: its words, a quiet hint, and the external-link mark at the right. */
function ExternalRow({ icon: Icon, children, trailing }: { icon: LucideIcon; children: ReactNode; trailing?: ReactNode }) {
  return (
    <>
      <Icon aria-hidden="true" className="text-muted-foreground" />
      <span className="min-w-0 flex-1">{children}</span>
      {trailing}
      <ExternalLinkIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
    </>
  )
}

/** Billing, cancel, card and synced devices live on cmem.ai; viewer accounts land here and have no other way there. */
const ACCOUNT_AND_BILLING_URL = 'https://cmem.ai/account'

/** The bar shows Memory from 768px up (components/app-bar.tsx), so the menu's Memory row is for phones. */
export function HeaderMenu() {
  const { t, locale, setLocale } = useI18n()
  const { team } = useWorkspace()
  // How many people the board shows, once the work has loaded; before that the bar's menu still opens.
  const peopleCount = useStore((state) => state.work.load.state === 'loaded' ? state.work.load.model.people.length : null)
  // The theme the page draws: a `?theme=` address for this visit, else the person's saved choice (G8).
  const theme = useStore((state) => themeChoiceInUse(state.view))
  const showSpec = useStore((state) => state.view.showSpec)
  const { setWorkspace, setTheme, setShowSpec } = useStore.getState()
  // The star count is seen only inside this menu, so GitHub is asked when the menu first opens, not on every page
  // load (as in the classic viewer's header).
  const [starsWanted, setStarsWanted] = useState(false)
  const stars = useGitHubStarCount(starsWanted)
  // The feedback row is named by its visible words (label in name); the longer phrase stays as its description.
  const feedbackDescriptionId = useId()
  // Team view on with one person says so (c-shell-team-switch M); off, it says what it shows.
  const teamHint = !team ? t('See everyone’s requests on one board, with who asked and where work collides.')
    : peopleCount === null ? null
      : interpolate(t(peopleCount === 1 ? '{count} person on this board' : '{count} people on this board'), { count: peopleCount })
  const chooseTheme = (value: string) => {
    if (!isThemeChoice(value)) throw new Error(`Unknown theme choice ${value}`)
    setTheme(value)
  }
  const languageSubmenuFits = useMatchesMedia(LANGUAGE_SUBMENU_FITS)
  const chooseLocale = (value: string) => {
    const chosen = LOCALES.find((code) => code === value)
    if (!chosen) throw new Error(`Unknown language ${value}`)
    setLocale(chosen)
  }
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) setStarsWanted(true) }}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('More')} className="text-muted-foreground [&_svg:not([class*='size-'])]:size-5">
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <Req ids={['R9.1', 'R9.4']}>
          {/* The product's name heads its rows, as it headed the team card these rows replace (App.tsx before 16.0.0). */}
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('TeamBrain')}</DropdownMenuLabel>
            {/* G6: Team view is a checkbox row with a one-line hint (it was a button that looked like a link). */}
            <DropdownMenuCheckboxItem checked={team} onCheckedChange={(checked) => setWorkspace({ team: checked })} className="items-start">
              <UsersIcon aria-hidden="true" className="mt-0.5 text-muted-foreground" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{t('Team view')}</span>
                {teamHint && <span className="text-xs text-muted-foreground">{teamHint}</span>}
              </span>
            </DropdownMenuCheckboxItem>
            {/* The team plan, a quiet link where a solid "Start team plan" button did nothing (App.tsx before 16.0.0). */}
            {!team && (
              <DropdownMenuItem asChild>
                <a href={TEAMBRAIN_START_URL} target="_blank" rel="noreferrer">
                  <ExternalRow icon={UsersIcon}>{t('Start team plan')}</ExternalRow>
                </a>
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        </Req>
        {languageSubmenuFits ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <GlobeIcon aria-hidden="true" className="text-muted-foreground" />
              <span className="flex-1">{t('Language')}</span>
              <span className="text-xs text-muted-foreground">{LOCALE_NAMES[locale]}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              {/* Never past the screen's edge, whichever side it opens on. */}
              <DropdownMenuSubContent collisionPadding={8}>
                <DropdownMenuRadioGroup value={locale} onValueChange={chooseLocale}>
                  {LOCALES.map((code) => <DropdownMenuRadioItem key={code} value={code} lang={code}>{LOCALE_NAMES[code]}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        ) : (
          <DropdownMenuGroup data-language-choices="inline">
            <DropdownMenuLabel className="flex items-center gap-2"><GlobeIcon aria-hidden="true" className="size-4 text-muted-foreground" />{t('Language')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={locale} onValueChange={chooseLocale}>
              {LOCALES.map((code) => <DropdownMenuRadioItem key={code} value={code} lang={code}>{LOCALE_NAMES[code]}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('Theme')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={chooseTheme}>
            {THEME_CHOICES.map((choice) => {
              const { words, icon: Icon } = THEME_CHOICE_LOOK[choice]
              return <DropdownMenuRadioItem key={choice} value={choice}><Icon aria-hidden="true" className="text-muted-foreground" />{t(words)}</DropdownMenuRadioItem>
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="md:hidden">
          <a href={MEMORY_PLACE.address}>
            <LibraryIcon aria-hidden="true" className="text-muted-foreground" />
            <span className="flex-1">{t(MEMORY_PLACE.label)}</span>
          </a>
        </DropdownMenuItem>
        {/* Cloud viewer only (R18.1); local My Work has no cmem.ai account to manage. */}
        {isServedFromCloud(window.location.hostname) && (
          <Req ids={['R18.1']}>
            <DropdownMenuItem asChild>
              <a href={ACCOUNT_AND_BILLING_URL}>
                <CreditCardIcon aria-hidden="true" className="text-muted-foreground" />
                <span className="flex-1">{t('Account & billing')}</span>
              </a>
            </DropdownMenuItem>
          </Req>
        )}
        <DropdownMenuItem asChild>
          <a href={MY_WORK_FEEDBACK_URL} target="_blank" rel="noreferrer" aria-describedby={feedbackDescriptionId}>
            <ExternalRow icon={MessageSquareIcon} trailing={<span className="text-xs text-muted-foreground">{t('Opens GitHub')}</span>}>{t('Send feedback')}</ExternalRow>
            <span id={feedbackDescriptionId} hidden>{t('Send feedback about My Work on GitHub')}</span>
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={CLAUDE_MEM_REPO_URL} target="_blank" rel="noreferrer">
            <ExternalRow icon={StarIcon} trailing={<StarCount read={stars} className="text-xs text-muted-foreground" />}>{t('Star on GitHub')}</ExternalRow>
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('Developer')}</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked={showSpec} onCheckedChange={setShowSpec}>{t('Show spec IDs')}</DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
