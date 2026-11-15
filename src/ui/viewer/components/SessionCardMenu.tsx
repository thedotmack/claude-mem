import React, { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n';

interface SessionCardMenuProps {
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onOpen: () => void;
  onDelete: () => void;
}

export function SessionCardMenu({ triggerRef, onClose, onOpen, onDelete }: SessionCardMenuProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      // The trigger's click toggles the menu itself. Closing on its mousedown
      // would make that subsequent click reopen the menu.
      if (menuRef.current && !menuRef.current.contains(target) && !triggerRef.current?.contains(target)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (menuRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, triggerRef]);

  return (
    <div className="session-card-menu" ref={menuRef} onClick={e => e.stopPropagation()}>
      <button className="session-card-menu-item" onClick={() => { onClose(); onOpen(); }}>
        {t('Open')}
      </button>
      <button className="session-card-menu-item session-card-menu-item--danger" onClick={() => { onClose(); onDelete(); }}>
        {t('Delete')}
      </button>
    </div>
  );
}
