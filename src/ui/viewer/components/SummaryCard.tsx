import React, { useId, useRef, useState } from "react";
import { useI18n, interpolate } from "../../i18n";
import { Summary } from "../types";
import type { DeletableItemType } from "../utils/feed-deletion";
import { useFeedItemDelete, type FeedItemDeletion } from "../hooks/useFeedItemDelete";
import { DELETE_ITEM_LABELS, DeleteConfirmation } from "./DeleteButton";
import { FoldRow } from "./FoldRow";
import { MenuButton, MenuItem, MenuSeparator } from "./MenuButton";
import { CopyMenuItem } from "./CopyButton";
import { ShortTime } from "./ShortTime";
import { formatCount } from "../utils/formatters";
import { TrashIcon } from "./icons";

const SECTIONS = [
  { key: "investigated", label: "Investigated", icon: "/icon-thick-investigated.svg" },
  { key: "learned", label: "Learned", icon: "/icon-thick-learned.svg" },
  { key: "completed", label: "Completed", icon: "/icon-thick-completed.svg" },
  { key: "next_steps", label: "Next Steps", icon: "/icon-thick-next-steps.svg" },
  { key: "notes", label: "Notes", icon: "/icon-thick-notes.svg" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

/**
 * How much of a summary shows: folded (the lead section only), one more section
 * opened from its chip, or every section. Folded is the default.
 */
export type SummarySectionMode = "folded" | "all" | SectionKey;

interface SummaryCardProps {
  summary: Summary;
  onDeleted: (itemType: DeletableItemType, id: number) => void;
  sectionMode?: SummarySectionMode;
  onSectionModeChange?: (mode: SummarySectionMode) => void;
  /** The list's record of this card's delete, so it outlives the card; a card on its own keeps its own. */
  deletion?: FeedItemDeletion;
  /** The page's heading already shows this summary's request (a session page pins its summary under it). */
  titleShownAbove?: boolean;
}

/** The summary as plain text for Copy text, with the section labels in the reader's language. */
function summaryText(summary: Summary, t: (english: string) => string): string {
  return [summary.request, ...SECTIONS.map(section => summary[section.key] ? `${t(section.label)}\n${summary[section.key]}` : null)]
    .filter(Boolean).join("\n\n");
}

export function SummaryCard({ summary, onDeleted, sectionMode, onSectionModeChange, deletion: listDeletion, titleShownAbove = false }: SummaryCardProps) {
  const { t } = useI18n();
  const [localMode, setLocalMode] = useState<SummarySectionMode>("folded");
  const mode = sectionMode ?? localMode;
  const setMode = (next: SummarySectionMode) => {
    if (sectionMode === undefined) setLocalMode(next);
    onSectionModeChange?.(next);
  };
  const ownDeletion = useFeedItemDelete("summary", summary.id, onDeleted);
  const deletion = listDeletion ?? ownDeletion;
  const cardRef = useRef<HTMLElement>(null);
  const sectionsId = useId();

  const sections = SECTIONS.filter((section) => summary[section.key]);
  // "Next steps" is the part to act on, so it leads; a summary without one leads with its first section.
  const lead = sections.find(section => section.key === "next_steps") ?? sections[0];
  const others = sections.filter(section => section !== lead);
  const isOpen = (key: SectionKey) => key === lead?.key || mode === "all" || mode === key;
  const source = summary.platform_source || "claude";

  return (
    <article ref={cardRef} className="card summary-card">
      <div className="card-line">
        <span className="card-kind summary-badge">{t('Session Summary')}</span>
        <span className={`card-source source-${source}`}>{source}</span>
        <span className="summary-project-badge card-project">{summary.project}</span>
        <ShortTime epoch={summary.created_at_epoch} className="card-time" />
      </div>
      {summary.request && !titleShownAbove && <h3 className="summary-title">{summary.request}</h3>}

      <div className="summary-sections" id={sectionsId}>
        {sections.map((section) => (
          <section
            key={section.key}
            className={`summary-section summary-section--${section.key === lead?.key ? 'lead' : 'more'}`}
            hidden={!isOpen(section.key)}
          >
            <div className="summary-section-header">
              <img
                src={section.icon}
                alt=""
                className={`summary-section-icon summary-section-icon--${section.key}`}
              />
              <h3 className="summary-section-label">{t(section.label)}</h3>
            </div>
            <div className="summary-section-content">
              {summary[section.key]}
            </div>
          </section>
        ))}
      </div>

      {others.length > 0 && (
        <>
          <div className="summary-chips" role="group" aria-label={t('Summary sections')}>
            {others.map(section => (
              <button
                key={section.key}
                type="button"
                className={`summary-chip${isOpen(section.key) ? ' active' : ''}`}
                aria-pressed={isOpen(section.key)}
                onClick={() => setMode(mode === section.key || mode === "all" ? "folded" : section.key)}
              >
                {t(section.label)}
              </button>
            ))}
          </div>
          <FoldRow label={t('Show all sections')} count={formatCount(sections.length)} open={mode === "all"}
            controls={sectionsId} onToggle={() => setMode(mode === "all" ? "folded" : "all")} />
        </>
      )}

      <div className="card-footer summary-card-footer">
        <span className="summary-meta-id">{interpolate(t('Session #{id}'), { id: summary.id })}</span>
        <span className="card-footer-spacer" />
        <MenuButton label={t('Summary actions')} triggerClassName="card-menu-trigger" menuClassName="card-menu">
          {close => (
            <>
              <CopyMenuItem label={t('Copy text')} text={() => summaryText(summary, t)} />
              <MenuSeparator />
              <MenuItem danger icon={<TrashIcon />} onSelect={() => { close(false); deletion.ask(); }}>
                {interpolate(t('Delete {item}…'), { item: t(DELETE_ITEM_LABELS.summary) })}
              </MenuItem>
            </>
          )}
        </MenuButton>
      </div>
      {deletion.stage !== 'idle' && (
        <DeleteConfirmation itemType="summary" deletion={deletion}
          returnFocus={() => cardRef.current?.querySelector<HTMLElement>('.card-menu-trigger')?.focus()} />
      )}
    </article>
  );
}
