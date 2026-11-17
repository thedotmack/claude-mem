import React from 'react';
import { useI18n } from '../../i18n';
import { ThemePreference } from '../hooks/useTheme';
import { MonitorIcon, MoonIcon, SunIcon } from './icons';

/**
 * The words for each theme choice in the header's "…" menu. "Light mode" rather
 * than "Light": the shared catalogs already give "Light" another meaning.
 */
export const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light mode',
  dark: 'Dark mode',
};

const THEME_ICONS: Record<ThemePreference, React.ReactNode> = {
  system: <MonitorIcon size={16} />,
  light: <SunIcon size={16} />,
  dark: <MoonIcon size={16} />,
};

const CYCLE_TITLES: Record<ThemePreference, string> = {
  system: 'Theme: System (click for Light)',
  light: 'Theme: Light (click for Dark)',
  dark: 'Theme: Dark (click for System)',
};

const NEXT_THEME: Record<ThemePreference, ThemePreference> = { system: 'light', light: 'dark', dark: 'system' };

interface ThemeToggleProps {
  preference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}

/**
 * One icon button that cycles System, Light and Dark, with its choice in the
 * tooltip and the accessible name. The header offers the three choices as words
 * in its "…" menu; this button stays mountable for layouts that want it on the bar.
 */
export function ThemeToggle({ preference, onThemeChange }: ThemeToggleProps) {
  const { t } = useI18n();
  const title = t(CYCLE_TITLES[preference]);
  return (
    <button
      type="button"
      className="theme-toggle-btn"
      onClick={() => onThemeChange(NEXT_THEME[preference])}
      title={title}
      aria-label={title}
    >
      {THEME_ICONS[preference]}
    </button>
  );
}
