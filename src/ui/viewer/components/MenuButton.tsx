import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { CheckIcon, DotsIcon } from './icons';

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

interface MenuButtonProps {
  /** Accessible name of the trigger, e.g. "More" or "Observation actions". */
  label: string;
  /** What the trigger shows; the "…" icon when left out. */
  icon?: React.ReactNode;
  triggerClassName?: string;
  menuClassName?: string;
  /** Which trigger edge the menu lines up with. */
  align?: 'start' | 'end';
  /** Told each time the menu opens or closes (the header fetches its star count on the first open). */
  onOpenChange?: (open: boolean) => void;
  /** The items. `close()` closes the menu and returns focus to the trigger; `close(false)` leaves focus to the caller. */
  children: (close: (returnFocus?: boolean) => void) => React.ReactNode;
}

/**
 * A button that opens a menu (WAI-ARIA menu button pattern): the menu has the
 * menu role, focus moves to its first item when it opens, Arrow keys, Home and End
 * move between items, Escape and a click outside close it and focus returns to the
 * button. The items stay in the page while the menu is closed, hidden.
 */
export function MenuButton({ label, icon, triggerClassName = '', menuClassName = '', align = 'end', onOpenChange, children }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const focusOnOpen = useRef<'first' | 'last'>('first');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])
    .filter(item => item.getClientRects().length > 0 && item.getAttribute('aria-disabled') !== 'true');

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) { setOpenUp(false); return; }
    const menu = menuRef.current, trigger = triggerRef.current;
    if (menu && trigger) {
      // Open upward only when the menu would leave the window below and fits above.
      const below = window.innerHeight - trigger.getBoundingClientRect().bottom;
      const above = trigger.getBoundingClientRect().top;
      setOpenUp(menu.offsetHeight > below && above > below);
    }
    const all = items();
    (focusOnOpen.current === 'last' ? all.at(-1) : all[0])?.focus();
  }, [open]);

  const reportOpen = useRef(onOpenChange);
  reportOpen.current = onOpenChange;
  useEffect(() => { reportOpen.current?.(open); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, close]);

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusOnOpen.current = event.key === 'ArrowUp' ? 'last' : 'first';
      if (open) { const all = items(); (event.key === 'ArrowUp' ? all.at(-1) : all[0])?.focus(); }
      else setOpen(true);
    }
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const all = items();
    const index = all.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => { event.preventDefault(); all[(next + all.length) % all.length]?.focus(); };
    switch (event.key) {
      case 'ArrowDown': case 'ArrowRight': move(index + 1); break;
      case 'ArrowUp': case 'ArrowLeft': move(index - 1); break;
      case 'Home': move(0); break;
      case 'End': move(all.length - 1); break;
      case 'Escape': event.preventDefault(); event.stopPropagation(); close(); break;
      case 'Tab': close(false); break;
    }
  };

  return (
    <div className={`menu-button${open ? ' menu-button--open' : ''}`} ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`menu-trigger ${triggerClassName}`.trim()}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => { focusOnOpen.current = 'first'; setOpen(value => !value); }}
        onKeyDown={onTriggerKeyDown}
      >
        {icon ?? <DotsIcon />}
      </button>
      <div
        className={`menu-popover menu-popover--${align}${openUp ? ' menu-popover--up' : ''} ${menuClassName}`.trim()}
        hidden={!open}
      >
        <div ref={menuRef} id={menuId} role="menu" aria-label={label} className="menu-list" onKeyDown={onMenuKeyDown}>
          {children(close)}
        </div>
      </div>
    </div>
  );
}

interface MenuItemProps {
  onSelect: () => void;
  icon?: React.ReactNode;
  /** Text at the right edge (a count, the current choice). */
  hint?: React.ReactNode;
  danger?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function MenuItem({ onSelect, icon, hint, danger = false, className = '', children }: MenuItemProps) {
  return (
    <button type="button" role="menuitem" tabIndex={-1} className={`menu-item${danger ? ' menu-item--danger' : ''} ${className}`.trim()} onClick={onSelect}>
      <span className="menu-item-icon" aria-hidden="true">{icon}</span>
      <span className="menu-item-label">{children}</span>
      {hint !== undefined && <span className="menu-item-hint">{hint}</span>}
    </button>
  );
}

interface MenuLinkProps {
  href: string;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  /** Opens in a new tab: an external page. */
  external?: boolean;
  title?: string;
  onSelect?: () => void;
  children: React.ReactNode;
}

export function MenuLink({ href, icon, hint, className = '', external = true, title, onSelect, children }: MenuLinkProps) {
  return (
    <a role="menuitem" tabIndex={-1} className={`menu-item ${className}`.trim()} href={href} title={title} onClick={onSelect}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
      <span className="menu-item-icon" aria-hidden="true">{icon}</span>
      <span className="menu-item-label">{children}</span>
      {hint !== undefined && <span className="menu-item-hint">{hint}</span>}
    </a>
  );
}

interface MenuRadioItemProps {
  checked: boolean;
  onSelect: () => void;
  icon?: React.ReactNode;
  className?: string;
  lang?: string;
  children: React.ReactNode;
}

export function MenuRadioItem({ checked, onSelect, icon, className = '', lang, children }: MenuRadioItemProps) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} tabIndex={-1} lang={lang}
      className={`menu-item menu-item--radio${checked ? ' menu-item--checked' : ''} ${className}`.trim()} onClick={onSelect}>
      <span className="menu-item-icon" aria-hidden="true">{icon}</span>
      <span className="menu-item-label">{children}</span>
      <span className="menu-item-check" aria-hidden="true">{checked && <CheckIcon size={14} />}</span>
    </button>
  );
}

export function MenuGroup({ label, icon, className = '', children }: { label: string; icon?: React.ReactNode; className?: string; children: React.ReactNode }) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className={`menu-group ${className}`.trim()}>
      <div id={labelId} className="menu-group-label" role="presentation">{icon && <span aria-hidden="true">{icon}</span>}{label}</div>
      {children}
    </div>
  );
}

export function MenuSeparator({ className = '' }: { className?: string }) {
  return <div role="separator" className={`menu-separator ${className}`.trim()} />;
}
