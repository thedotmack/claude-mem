import React from 'react';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  isLoading: boolean;
  placeholder?: string;
}

export function SearchInput({ value, onChange, isLoading, placeholder = 'Search semantically...' }: SearchInputProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };

  const handleClear = () => {
    onChange('');
  };

  return (
    <div className="search-input-container">
      <div className="search-icon">
        {isLoading ? (
          <span className="search-spinner" />
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M7.25 12.5C10.1495 12.5 12.5 10.1495 12.5 7.25C12.5 4.35051 10.1495 2 7.25 2C4.35051 2 2 4.35051 2 7.25C2 10.1495 4.35051 12.5 7.25 12.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M10.9624 10.9624L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </div>
      <input
        type="text"
        className="search-input"
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
      {value && (
        <button
          type="button"
          className="search-clear-btn"
          onClick={handleClear}
          title="Clear search"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}
    </div>
  );
}
