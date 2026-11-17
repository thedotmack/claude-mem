import React, { useLayoutEffect, useRef, useState } from 'react';
import { useI18n, interpolate } from '../../i18n';
import { Observation } from '../types';
import { ObservationMediaSection } from './ObservationMedia';
import type { DeletableItemType } from '../utils/feed-deletion';
import { parseStoredStringList } from '../utils/stored-string-list';
import { useFeedItemDelete, type FeedItemDeletion } from '../hooks/useFeedItemDelete';
import { DELETE_ITEM_LABELS, DeleteConfirmation } from './DeleteButton';
import { MenuButton, MenuItem, MenuSeparator } from './MenuButton';
import { CopyMenuItem } from './CopyButton';
import { ShortTime } from './ShortTime';
import { FileIcon, TrashIcon } from './icons';

export type ObservationViewMode = 'summary' | 'facts' | 'narrative';
interface ObservationCardProps {
  observation: Observation;
  onDeleted: (itemType: DeletableItemType, id: number) => void;
  viewMode?: ObservationViewMode;
  onViewModeChange?: (mode: ObservationViewMode) => void;
  /** The list's record of this card's delete, so it outlives the card; a card on its own keeps its own. */
  deletion?: FeedItemDeletion;
  /** Whether the one-line summary is opened in full; the list keeps it so it survives the row being recycled. */
  subtitleOpen?: boolean;
  onSubtitleOpenChange?: (open: boolean) => void;
}

function stripProjectRoot(storedPath: string): string {
  // Windows sessions record `C:\Users\…\src\app.ts`; shorten it like a `/` path.
  const filePath = storedPath.replace(/\\/g, '/');
  const markers = ['/Scripts/', '/src/', '/plugin/', '/docs/'];

  for (const marker of markers) {
    const index = filePath.indexOf(marker);
    if (index !== -1) {
      return filePath.substring(index + 1);
    }
  }

  const projectIndex = filePath.indexOf('claude-mem/');
  if (projectIndex !== -1) {
    return filePath.substring(projectIndex + 'claude-mem/'.length);
  }

  const parts = filePath.split('/');
  return parts.length > 3 ? parts.slice(-3).join('/') : filePath;
}

/**
 * The plain text of an observation for Copy text: every section its card can show (G4), as the summary card's
 * Copy text has every section, folded ones too. Title, one-line summary, narrative, then the Facts view (its facts,
 * concepts and files), with the card's own labels in the reader's language.
 */
export function observationText(observation: Observation, t: (english: string) => string): string {
  const facts = parseStoredStringList(observation.facts);
  const concepts = parseStoredStringList(observation.concepts);
  const filesRead = parseStoredStringList(observation.files_read);
  const filesModified = parseStoredStringList(observation.files_modified);
  return [
    observation.title,
    observation.subtitle,
    observation.narrative,
    facts.length ? `${t('Facts')}\n${facts.map(fact => `- ${fact}`).join('\n')}` : null,
    concepts.length ? concepts.join(', ') : null,
    filesRead.length ? `${t('read:')} ${filesRead.join(', ')}` : null,
    filesModified.length ? `${t('modified:')} ${filesModified.join(', ')}` : null,
  ].filter(Boolean).join('\n\n');
}

/**
 * The one line under the title (F15). When the line is cut, "Show more" opens the whole
 * text in place, so nothing is lost to the fold; Copy text in "…" has it too.
 */
function Subtitle({ text, open: controlledOpen, onOpenChange }: { text: string; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const { t } = useI18n();
  const lineRef = useRef<HTMLSpanElement>(null);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };
  const [cut, setCut] = useState(false);
  // Measured after every render: the card's width changes with the window and the list's re-renders.
  useLayoutEffect(() => {
    const line = lineRef.current;
    if (!line || open) return;
    const isCut = line.scrollWidth > line.clientWidth + 1;
    if (isCut !== cut) setCut(isCut);
  });
  return (
    <div className={`card-subtitle${open ? ' card-subtitle--open' : ''}`}>
      <span ref={lineRef} className="card-subtitle-text">{text}</span>
      {(cut || open) && (
        <button type="button" className="link-button card-subtitle-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t('Show less') : t('Show more')}
        </button>
      )}
    </div>
  );
}

export function ObservationCard({
  observation, onDeleted, viewMode, onViewModeChange, deletion: listDeletion, subtitleOpen, onSubtitleOpenChange,
}: ObservationCardProps) {
  const { t } = useI18n();
  const [localViewMode, setLocalViewMode] = useState<ObservationViewMode>('summary');
  const mode = viewMode ?? localViewMode;
  const showFacts = mode === 'facts';
  const showNarrative = mode === 'narrative';
  const setMode = (next: ObservationViewMode) => {
    if (viewMode === undefined) setLocalViewMode(next);
    onViewModeChange?.(next);
  };
  const ownDeletion = useFeedItemDelete('observation', observation.id, onDeleted);
  const deletion = listDeletion ?? ownDeletion;
  const cardRef = useRef<HTMLElement>(null);

  const facts = parseStoredStringList(observation.facts);
  const concepts = parseStoredStringList(observation.concepts);
  const filesRead = parseStoredStringList(observation.files_read).map(stripProjectRoot);
  const filesModified = parseStoredStringList(observation.files_modified).map(stripProjectRoot);

  const hasFactsContent = facts.length > 0 || concepts.length > 0 || filesRead.length > 0 || filesModified.length > 0;
  const source = observation.platform_source || 'claude';

  return (
    <article ref={cardRef} className={`card observation-card kind-${observation.type}`}>
      <div className="card-line">
        <span className={`card-kind type-${observation.type}`}>{t(observation.type)}</span>
        <span className={`card-source source-${source}`}>{source}</span>
        <span className="card-project">{observation.project}</span>
        {observation.merged_into_project && (
          <span className="card-merged-badge" title={interpolate(t('Merged into {project}'), { project: observation.merged_into_project })}>
            {interpolate(t('merged → {project}'), { project: observation.merged_into_project })}
          </span>
        )}
        <ShortTime epoch={observation.created_at_epoch} className="card-time" />
      </div>

      <h3 className="card-title">{observation.title || t('Untitled')}</h3>

      <div className="view-mode-content">
        {!showFacts && !showNarrative && observation.subtitle && (
          <Subtitle text={observation.subtitle} open={subtitleOpen} onOpenChange={onSubtitleOpenChange} />
        )}
        {showFacts && (
          <div className="facts-panel">
            {facts.length > 0 && (
              <ul className="facts-list">
                {facts.map((fact: string, i: number) => (
                  <li key={i}>{fact}</li>
                ))}
              </ul>
            )}
            {concepts.length > 0 && (
              <div className="concept-chips">
                {concepts.map((concept: string, i: number) => <span key={i} className="concept-chip">{concept}</span>)}
              </div>
            )}
            {filesRead.length > 0 && (
              <p className="meta-files">
                <FileIcon size={14} /><span className="file-label">{t('read:')}</span> {filesRead.join(', ')}
              </p>
            )}
            {filesModified.length > 0 && (
              <p className="meta-files">
                <FileIcon size={14} /><span className="file-label">{t('modified:')}</span> {filesModified.join(', ')}
              </p>
            )}
          </div>
        )}
        {showNarrative && observation.narrative && (
          <div className="narrative">
            {observation.narrative}
          </div>
        )}
      </div>

      {/* Attached images: only rows with validated media refs render this */}
      {observation.media && observation.media.attachments.length > 0 && (
        <ObservationMediaSection observationId={observation.id} media={observation.media} />
      )}

      <div className="card-footer">
        <span className="meta-date card-id">#{observation.id}</span>
        {hasFactsContent && (
          <button
            type="button"
            className={`view-mode-toggle${showFacts ? ' active' : ''}`}
            aria-pressed={showFacts}
            onClick={() => setMode(showFacts ? 'summary' : 'facts')}
          >
            {t('Facts')}{facts.length > 0 && <span className="view-mode-count">{facts.length}</span>}
          </button>
        )}
        {observation.narrative && (
          <button
            type="button"
            className={`view-mode-toggle${showNarrative ? ' active' : ''}`}
            aria-pressed={showNarrative}
            onClick={() => setMode(showNarrative ? 'summary' : 'narrative')}
          >
            {t('Narrative')}
          </button>
        )}
        <span className="card-footer-spacer" />
        <MenuButton label={t('Observation actions')} triggerClassName="card-menu-trigger" menuClassName="card-menu">
          {close => (
            <>
              <CopyMenuItem label={interpolate(t('Copy id #{id}'), { id: observation.id })} text={() => String(observation.id)} />
              <CopyMenuItem label={t('Copy text')} text={() => observationText(observation, t)} />
              <MenuSeparator />
              <MenuItem danger icon={<TrashIcon />} onSelect={() => { close(false); deletion.ask(); }}>
                {interpolate(t('Delete {item}…'), { item: t(DELETE_ITEM_LABELS.observation) })}
              </MenuItem>
            </>
          )}
        </MenuButton>
      </div>
      {deletion.stage !== 'idle' && (
        <DeleteConfirmation itemType="observation" deletion={deletion}
          returnFocus={() => cardRef.current?.querySelector<HTMLElement>('.card-menu-trigger')?.focus()} />
      )}
    </article>
  );
}
