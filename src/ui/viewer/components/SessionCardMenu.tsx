import React from 'react';
import { interpolate, useI18n } from '../../i18n';
import { MenuButton, MenuItem, MenuSeparator } from './MenuButton';
import { ArrowRightIcon, TrashIcon } from './icons';

interface SessionCardMenuProps {
  onOpen: () => void;
  /** Starts the delete: the row then asks in the page how many memories will go. */
  onDelete: () => void;
}

/**
 * A session row's "…" menu, beside the row's own link (never inside it): Open, a line, then
 * "Delete session…". Built on the shared menu button, so it has the menu role, Arrow keys,
 * Home and End move between its 40px rows, and Escape or a click outside closes it with focus
 * back on the button.
 */
export function SessionCardMenu({ onOpen, onDelete }: SessionCardMenuProps) {
  const { t } = useI18n();
  return (
    <MenuButton label={t('Session actions')} triggerClassName="session-card-menu-trigger" menuClassName="session-card-menu">
      {close => (
        <>
          <MenuItem icon={<ArrowRightIcon />} className="session-card-menu-item" onSelect={() => { close(false); onOpen(); }}>
            {t('Open')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<TrashIcon />} className="session-card-menu-item session-card-menu-item--danger"
            onSelect={() => { close(false); onDelete(); }}>
            {interpolate(t('Delete {item}…'), { item: t('session') })}
          </MenuItem>
        </>
      )}
    </MenuButton>
  );
}
