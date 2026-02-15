import React, { useRef, useCallback, useEffect } from 'react';

interface SearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  isSearching: boolean;
  resultCount: string | null;
}

export function SearchBar({ query, onQueryChange, isSearching, resultCount }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClear = useCallback(() => {
    onQueryChange('');
    inputRef.current?.focus();
  }, [onQueryChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClear();
    }
  }, [handleClear]);

  // Global "/" shortcut to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const el = e.target as HTMLElement;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return;
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); };
  }, []);

  return (
    <div className="search-bar">
      <svg className="search-bar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
      <input
        ref={inputRef}
        type="text"
        className="search-bar-input"
        placeholder="Search observations..."
        value={query}
        onChange={e => { onQueryChange(e.target.value); }}
        onKeyDown={handleKeyDown}
        aria-label="Search observations"
      />
      {isSearching && (
        <div className="search-bar-spinner" aria-label="Searching" />
      )}
      {resultCount !== null && !isSearching && (
        <span className="search-bar-count">{resultCount}</span>
      )}
      {query && (
        <button
          className="search-bar-clear"
          onClick={handleClear}
          aria-label="Clear search"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      )}
    </div>
  );
}
