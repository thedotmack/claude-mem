import React, { useState } from 'react';
import { useI18n, interpolate } from '../../i18n';
import { UserPrompt } from '../types';
import { formatCount, formatDate } from '../utils/formatters';
import { ShortTime } from './ShortTime';
import { CopyButton } from './CopyButton';
import { ChevronDownIcon } from './icons';

interface PromptCardProps {
  prompt: UserPrompt;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Older prompts with the same words typed just before this one, newest first; folded into this row. */
  repeats?: UserPrompt[];
  repeatsOpen?: boolean;
  onRepeatsOpenChange?: (open: boolean) => void;
}

// A prompt past these bounds shows three lines plus "Show all <n> characters"
// (#4757: machine-driven sessions produce multi-thousand-character "user" turns
// that would otherwise push the observations and summaries off screen). Three
// lines is the mockup's fold; 225 characters is three lines at the 75-character
// measure the timeline holds body text to (UI UX Pro Max line-length).
const CLAMP_LINES = 3;
const CLAMP_MIN_CHARS = 3 * 75;
// One row (label, words, project and time on one line) fits about 60 characters
// at 15px beside the PROMPT label and the project and time in the 760px column.
const ONE_LINE_MAX_CHARS = 60;

/**
 * One prompt row. The owner's prompts are set apart from machine output (observations
 * and summaries) by their 15px primary-text words (F17). Machine-written "user" turns,
 * such as claude-mem's own auto-clear notice and the "continue" it sends, cannot be set
 * apart from the owner's typed prompts yet: a prompt row carries only id, session,
 * project, platform_source, prompt_number, prompt_text and created_at (user_prompts has
 * no field saying who wrote the turn), and guessing from the words would mislabel real
 * prompts. Once the worker marks such turns, style them here.
 */
export function PromptCard({ prompt, expanded: controlledExpanded, onExpandedChange, repeats = [], repeatsOpen: controlledRepeatsOpen, onRepeatsOpenChange }: PromptCardProps) {
  const { t } = useI18n();
  const [localExpanded, setLocalExpanded] = useState(false);
  const [localRepeatsOpen, setLocalRepeatsOpen] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const repeatsOpen = controlledRepeatsOpen ?? localRepeatsOpen;
  const setExpanded = (next: boolean) => {
    if (controlledExpanded === undefined) setLocalExpanded(next);
    onExpandedChange?.(next);
  };
  const setRepeatsOpen = (next: boolean) => {
    if (controlledRepeatsOpen === undefined) setLocalRepeatsOpen(next);
    onRepeatsOpenChange?.(next);
  };
  const text = prompt.prompt_text;
  const lines = text.split('\n').length;
  const isLong = lines > CLAMP_LINES || text.length > CLAMP_MIN_CHARS;
  const oneLine = lines === 1 && text.length <= ONE_LINE_MAX_CHARS;
  const clamped = isLong && !expanded;
  const source = prompt.platform_source || 'claude';
  const times = repeats.length + 1;

  const meta = (
    <span className="prompt-meta">
      <span className="card-project">{prompt.project}</span>
      <ShortTime epoch={prompt.created_at_epoch} className="card-time" detail={`${source} · #${prompt.id}`} />
    </span>
  );
  const repeatChip = repeats.length > 0 && (
    <button type="button" className={`prompt-repeat-chip${repeatsOpen ? ' active' : ''}`} aria-expanded={repeatsOpen}
      onClick={() => setRepeatsOpen(!repeatsOpen)}>
      {interpolate(t('{count} times in a row'), { count: times })}
    </button>
  );

  return (
    <div className={`card prompt-card${oneLine ? ' prompt-card--line' : ''}`}>
      {oneLine ? (
        <div className="prompt-row">
          <span className="card-kind prompt-kind">{t('Prompt')}</span>
          <span className="card-content prompt-text">{text}</span>
          {repeatChip}
          {meta}
        </div>
      ) : (
        <>
          <div className="card-line">
            <span className="card-kind prompt-kind">{t('Prompt')}</span>
            <span className={`card-source source-${source}`}>{source}</span>
            {repeatChip}
            {meta}
          </div>
          <div className={`card-content prompt-text${clamped ? ' card-content-clamped' : ''}`}>
            {text}
          </div>
          {isLong && (
            <div className="prompt-actions">
              <button
                type="button"
                className="prompt-show-more link-button"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? t('Show less') : interpolate(t('Show all {count} characters'), { count: formatCount(text.length) })}
                <ChevronDownIcon size={14} />
              </button>
              <CopyButton label={t('Copy')} text={() => text} />
            </div>
          )}
        </>
      )}
      {repeats.length > 0 && repeatsOpen && (
        <ul className="prompt-repeats" aria-label={t('Earlier times')}>
          {repeats.map(repeat => (
            <li key={repeat.id}>
              <span className={`card-source source-${repeat.platform_source || 'claude'}`}>{repeat.platform_source || 'claude'}</span>
              <span className="card-project">{repeat.project}</span>
              <span className="meta-date" title={formatDate(repeat.created_at_epoch)}>{formatDate(repeat.created_at_epoch)}</span>
              <span className="meta-date">#{repeat.id}</span>
              {/* A repeat folds by its words, whatever their case and spacing (foldPromptRepeats); one typed
                  differently keeps its own text here, so nothing it said is lost (rule 2). */}
              {repeat.prompt_text !== text && <span className="prompt-repeat-text">{repeat.prompt_text}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
