import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n, interpolate } from '../../i18n';
import { formatCount } from '../utils/formatters';
import { CheckIcon, ChevronDownIcon, FilterIcon, SearchIcon } from './icons';

// UI UX Pro Max `virtualize-lists`: draw 50 matches, then offer the rest with their count.
const SHOWN_MATCHES = 50;

interface ProjectPickerProps {
  projects: string[];
  value: string;
  onChange: (project: string) => void;
}

/**
 * The labelled, searchable Project filter (a combobox with a listbox): typing
 * narrows hundreds of projects, Arrow keys move, Enter chooses, Escape closes.
 */
export function ProjectPicker({ projects, value, onChange }: ProjectPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const labelId = useId(), valueId = useId(), listId = useId(), optionPrefix = useId();
  const allLabel = t('All Projects');

  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? projects.filter(project => words.every(word => project.toLowerCase().includes(word))) : projects;
  }, [projects, query]);
  const firstMatches = matches.slice(0, SHOWN_MATCHES);
  // The chosen project stays listed, checked and first, when it matches but falls past the first 50.
  const chosenPastFirst = !showAll && value !== '' && !firstMatches.includes(value) && matches.includes(value);
  const shown = showAll ? matches : chosenPastFirst ? [value, ...firstMatches] : firstMatches;
  // Option 0 is "All projects" while the search is empty.
  const options = query ? shown : ['', ...shown];
  // "Show all <n>" is the last option, so Arrow keys, End and Enter reach it like any project.
  const hiddenCount = matches.length - shown.length;
  const showAllIndex = hiddenCount > 0 ? options.length : -1;
  const optionCount = options.length + (hiddenCount > 0 ? 1 : 0);

  useEffect(() => { setActive(0); setShowAll(false); }, [query]);
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    // A click outside closes it the way Escape and Tab do, search cleared, so it opens on every project next time.
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (returnFocus) triggerRef.current?.focus();
  };
  const choose = (project: string) => {
    onChange(project);
    close(true);
  };
  // The next project after the first 50 becomes the active option; focus stays in the search field.
  const showEveryMatch = () => { setShowAll(true); setActive(SHOWN_MATCHES + (query ? 0 : 1)); inputRef.current?.focus(); };
  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(optionCount - 1, index + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
    else if (event.key === 'Home' && !query) { event.preventDefault(); setActive(0); }
    else if (event.key === 'End' && !query) { event.preventDefault(); setActive(optionCount - 1); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      if (active === showAllIndex) showEveryMatch();
      else if (options[active] !== undefined) choose(options[active]);
    }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close(false);
  };
  const current = value || allLabel;

  return (
    <div className={`project-picker${value ? ' project-picker--filtered' : ''}`} ref={wrapperRef}>
      <span className="project-picker-label" id={labelId}>{t('Project')}</span>
      <button
        ref={triggerRef}
        type="button"
        className="project-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`}
        title={current}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}
      >
        <span className="project-picker-icon" aria-hidden="true"><FilterIcon size={16} /></span>
        <span className="project-picker-value" id={valueId}>{current}</span>
        <span className="project-picker-chevron" aria-hidden="true"><ChevronDownIcon size={14} /></span>
      </button>
      <div className="project-picker-popover" role="dialog" aria-label={t('Choose a project')} hidden={!open}>
        <div className="project-picker-search">
          <SearchIcon size={16} />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={optionCount ? `${optionPrefix}-${active}` : undefined}
            aria-label={t('Find a project')}
            placeholder={t('Find a project')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
        </div>
        <p className="project-picker-count" aria-live="polite">
          {query
            ? interpolate(t('{count} of {total} projects match'), { count: formatCount(matches.length), total: formatCount(projects.length) })
            : interpolate(t('{count} projects'), { count: formatCount(projects.length) })}
        </p>
        <ul ref={listRef} role="listbox" id={listId} aria-label={t('Projects')} className="project-picker-list">
          {options.map((project, index) => (
            <li
              key={project || '__all__'}
              id={`${optionPrefix}-${index}`}
              data-index={index}
              data-value={project}
              role="option"
              aria-selected={project === value}
              className={`project-picker-option${index === active ? ' active' : ''}`}
              onMouseDown={event => event.preventDefault()}
              onMouseMove={() => setActive(index)}
              onClick={() => choose(project)}
            >
              <span className="project-picker-check" aria-hidden="true">{project === value && <CheckIcon size={14} />}</span>
              <span className="project-picker-name">{project || allLabel}</span>
            </li>
          ))}
          {showAllIndex >= 0 && (
            <li
              id={`${optionPrefix}-${showAllIndex}`}
              data-index={showAllIndex}
              role="option"
              aria-selected={false}
              className={`project-picker-option project-picker-more${active === showAllIndex ? ' active' : ''}`}
              onMouseDown={event => event.preventDefault()}
              onMouseMove={() => setActive(showAllIndex)}
              onClick={showEveryMatch}
            >
              <span className="project-picker-check" aria-hidden="true" />
              <span className="project-picker-name">{interpolate(t('Show all {count}'), { count: formatCount(matches.length) })}</span>
            </li>
          )}
          {options.length === 0 && <li className="project-picker-none" role="presentation">{t('No project matches')}</li>}
        </ul>
      </div>
    </div>
  );
}
