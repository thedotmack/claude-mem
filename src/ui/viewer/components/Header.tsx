import React, { useEffect, useId, useRef, useState } from 'react';
import { LOCALES, LOCALE_NAMES, useI18n, interpolate } from '../../i18n';
import { THEME_LABELS } from './ThemeToggle';
import { THEME_PREFERENCES, type ThemePreference } from '../hooks/useTheme';
import { useSpinningFavicon } from '../hooks/useSpinningFavicon';
import { formatStarCount, useGitHubStars } from '../hooks/useGitHubStars';
import { PRO_TRIAL_PITCH, PRO_TRIAL_SHORT, PRO_TRIAL_URL, TEAMBRAIN_PITCH, TEAMBRAIN_START_URL } from '../constants/promo';
import { syncDetailWords, type SyncPresentation } from '../utils/sync-presentation';
import { formatCount } from '../utils/formatters';
import { ProjectPicker } from './ProjectPicker';
import { MenuButton, MenuGroup, MenuItem, MenuLink, MenuRadioItem, MenuSeparator } from './MenuButton';
import {
  BookIcon, DiscordIcon, GearIcon, GlobeIcon, HelpIcon, SparkleIcon, StarIcon, TerminalIcon, UsersIcon, XLogoIcon,
} from './icons';

interface HeaderProps {
  projects: string[];
  currentFilter: string;
  onFilterChange: (filter: string) => void;
  isProcessing: boolean;
  queueDepth: number;
  isConnected?: boolean;
  syncStatus?: SyncPresentation;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onContextPreviewToggle: () => void;
  onShowHelp?: () => void;
  /** Show the TeamBrain link: settings have loaded and this install is in no team. */
  showTeamBrainLink?: boolean;
  /** The timeline supplies its own dismissible Cloud Sync offer. */
  showProTrialLink?: boolean;
  /** Opens the memory logs; offered in the "…" menu where the floating logs button is hidden (narrow screens). */
  onOpenLogs?: () => void;
}

const syncTone = (syncStatus: SyncPresentation, isConnected: boolean) => isConnected ? syncStatus.tone : 'warning';

/**
 * The sync state on the header row: a dot and one short label. Its full words (the
 * feed connection and the sync detail) open under it on hover, on keyboard focus and
 * on tap or click (G10), and screen readers hear them as its description.
 */
function SyncState({ syncStatus, isConnected }: { syncStatus: SyncPresentation; isConnected: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  const detailId = useId();
  const feed = isConnected ? t('Feed connected') : t('Feed disconnected');
  // The same words as a sentence: each language ends it its own way ("。" in Chinese).
  const feedSentence = isConnected ? t('Feed connected.') : t('Feed disconnected.');
  useEffect(() => {
    if (!open) return;
    // A tap elsewhere closes it (a tapped button does not always take focus, so blur alone is not enough).
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);
  return (
    <span ref={wrapperRef} className="header-sync-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => { if (!wrapperRef.current?.contains(document.activeElement)) setOpen(false); }}>
      <button type="button" className={`header-sync header-sync--${syncTone(syncStatus, isConnected)}`} data-sync-state={syncStatus.state}
        aria-expanded={open} aria-controls={panelId} aria-describedby={detailId}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}
        onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); } }}>
        <span className="header-sync-dot" aria-hidden="true" />
        {isConnected
          ? <span className="visually-hidden">{feedSentence} </span>
          : <span className="header-sync-feed">{feed} · </span>}
        <span className="header-sync-label">{t(syncStatus.label)}</span>
      </button>
      <span id={panelId} role="tooltip" className="header-sync-detail" hidden={!open}>
        <strong>{feedSentence}</strong> <span id={detailId}>{syncDetailWords(syncStatus, t)}</span>
      </span>
    </span>
  );
}

/**
 * One row: My Work, the logo with the queue count, sync state, the Project filter,
 * Settings, the trial link and one "…" menu holding everything else (links, stars,
 * theme, language, TeamBrain, the welcome card, memory logs). At 1100px and under the sync
 * state (with its full words) and the trial link move into the menu (a dot beside the logo
 * keeps the sync tone); on a phone the row is My Work, the logo, Project, Settings and "…" at 44px.
 */
export function Header({
  projects,
  currentFilter,
  onFilterChange,
  isProcessing,
  queueDepth,
  isConnected = false,
  syncStatus,
  themePreference,
  onThemeChange,
  onContextPreviewToggle,
  onShowHelp,
  showTeamBrainLink = false,
  showProTrialLink = true,
  onOpenLogs,
}: HeaderProps) {
  const { t, locale, setLocale } = useI18n();
  useSpinningFavicon(isProcessing);
  // The star count is only seen inside the "…" menu, so GitHub is asked once, when the menu first opens.
  const [starsWanted, setStarsWanted] = useState(false);
  const github = useGitHubStars('thedotmack', 'claude-mem', starsWanted);
  const starTitle = github.stars !== null
    ? interpolate(t('Star us on GitHub ({count} stars)'), { count: formatCount(github.stars) })
    : t('Star us on GitHub');
  const queueLabel = interpolate(t('{count} waiting to be processed'), { count: queueDepth });

  return (
    <header className="header">
      <a href="/" className="local-work-link" title={t('Open your local work and review queue')}>{t('My Work')}</a>
      <h1 className="header-logo">
        <span className="logomark-wrap">
          <img src="claude-mem-logomark.webp" alt="" className={`logomark ${isProcessing ? 'spinning' : ''}`} />
          {queueDepth > 0 && (
            <span className="queue-bubble" title={queueLabel}>
              <span aria-hidden="true">{queueDepth}</span>
              <span className="visually-hidden">{queueLabel}</span>
            </span>
          )}
        </span>
        <span className="logo-text">claude-mem</span>
      </h1>
      {syncStatus && <span className="header-sync-phone-dot" aria-hidden="true" data-tone={syncTone(syncStatus, isConnected)} />}
      <span className="header-spacer" />
      {syncStatus && <SyncState syncStatus={syncStatus} isConnected={isConnected} />}
      <ProjectPicker projects={projects} value={currentFilter} onChange={onFilterChange} />
      <button
        type="button"
        className="settings-btn"
        onClick={onContextPreviewToggle}
        title={t('Settings')}
        aria-label={t('Settings')}
      >
        <GearIcon size={18} />
      </button>
      {showProTrialLink && <a
        className="pro-trial-cta header-trial"
        href={PRO_TRIAL_URL}
        target="_blank"
        rel="noopener noreferrer"
        title={t(PRO_TRIAL_PITCH)}
        aria-label={t(PRO_TRIAL_PITCH)}
      >
        <SparkleIcon size={14} />
        <span className="pro-trial-cta-short">{t(PRO_TRIAL_SHORT)}</span>
      </a>}
      <MenuButton
        label={t('More')}
        triggerClassName="header-more"
        menuClassName="header-menu"
        onOpenChange={open => { if (open) setStarsWanted(true); }}
      >
        {close => (
          <>
            {syncStatus && (
              // The sync state and its full words, as the first item so arrow keys and taps reach them.
              <MenuItem className="menu-compact-only menu-sync" onSelect={() => close()}
                icon={<span className="header-sync-dot" data-tone={syncTone(syncStatus, isConnected)} />}>
                <span className="menu-sync-label">{isConnected ? t('Feed connected') : t('Feed disconnected')} · {t(syncStatus.label)}</span>
                <span className="menu-sync-detail">{syncDetailWords(syncStatus, t)}</span>
              </MenuItem>
            )}
            {showProTrialLink && <MenuLink className="menu-compact-only" href={PRO_TRIAL_URL} icon={<SparkleIcon />} title={t(PRO_TRIAL_PITCH)} onSelect={() => close()}>
              {t(PRO_TRIAL_SHORT)}
            </MenuLink>}
            <MenuSeparator className="menu-compact-only" />
            <MenuLink href="https://docs.claude-mem.ai" icon={<BookIcon />} onSelect={() => close()}>{t('Documentation')}</MenuLink>
            <MenuLink href="https://x.com/Claude_Memory" icon={<XLogoIcon />} onSelect={() => close()}>{t('Follow us on X')}</MenuLink>
            <MenuLink href="https://discord.gg/J4wttp9vDu" icon={<DiscordIcon />} onSelect={() => close()}>{t('Join our Discord community')}</MenuLink>
            <MenuLink href={github.repoUrl} icon={<StarIcon />} title={starTitle} onSelect={() => close()}
              hint={github.stars !== null ? <span className="tabular">{formatStarCount(github.stars)}</span> : undefined}>
              {t('Star on GitHub')}
            </MenuLink>
            <MenuSeparator />
            <MenuGroup label={t('Theme')} className="menu-group--segments">
              {THEME_PREFERENCES.map(choice => (
                <MenuRadioItem key={choice} checked={themePreference === choice} className="menu-segment"
                  onSelect={() => onThemeChange(choice)}>
                  {t(THEME_LABELS[choice])}
                </MenuRadioItem>
              ))}
            </MenuGroup>
            <MenuGroup label={t('Language')} icon={<GlobeIcon size={14} />}>
              {LOCALES.map(code => (
                <MenuRadioItem key={code} checked={locale === code} lang={code} onSelect={() => setLocale(code)}>
                  {LOCALE_NAMES[code]}
                </MenuRadioItem>
              ))}
            </MenuGroup>
            <MenuSeparator />
            {showTeamBrainLink && (
              <MenuLink className="teambrain-cta" href={TEAMBRAIN_START_URL} icon={<UsersIcon />} title={t(TEAMBRAIN_PITCH)} onSelect={() => close()}>
                TeamBrain
              </MenuLink>
            )}
            <MenuItem icon={<HelpIcon />} onSelect={() => { close(); onShowHelp?.(); }}>
              {t('Show welcome card')}
            </MenuItem>
            {onOpenLogs && (
              <MenuItem icon={<TerminalIcon />} onSelect={() => { close(); onOpenLogs(); }}>
                {t('Memory logs')}
              </MenuItem>
            )}
          </>
        )}
      </MenuButton>
    </header>
  );
}
