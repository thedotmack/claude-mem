import React from 'react';

interface FilterChipProps {
  label: string;
  isSelected: boolean;
  onToggle: () => void;
}

export function FilterChip({ label, isSelected, onToggle }: FilterChipProps) {
  return (
    <button
      className={`chip ${isSelected ? 'selected' : ''}`}
      onClick={onToggle}
      aria-pressed={isSelected}
    >
      {label}
    </button>
  );
}
