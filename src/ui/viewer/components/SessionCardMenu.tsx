import React, { useEffect, useRef } from 'react';

interface SessionCardMenuProps {
  onClose: () => void;
  onOpen: () => void;
  onDelete: () => void;
}

export function SessionCardMenu({ onClose, onOpen, onDelete }: SessionCardMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className="session-card-menu" ref={menuRef} onClick={e => e.stopPropagation()}>
      <button className="session-card-menu-item" onClick={() => { onClose(); onOpen(); }}>
        Open
      </button>
      <button className="session-card-menu-item session-card-menu-item--danger" onClick={() => { onClose(); onDelete(); }}>
        Delete
      </button>
    </div>
  );
}
