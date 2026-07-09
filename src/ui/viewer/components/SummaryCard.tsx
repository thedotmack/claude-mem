import React from "react";
import { Summary } from "../types";
import { formatDate } from "../utils/formatters";
import { useI18n } from '../i18n/I18nContext';

interface SummaryCardProps {
  summary: Summary;
}

export function SummaryCard({ summary }: SummaryCardProps) {
  const date = formatDate(summary.created_at_epoch);
  const { t } = useI18n();

  const sections = [
    { key: "investigated", label: t('card.investigated'), content: summary.investigated, icon: "/icon-thick-investigated.svg" },
    { key: "learned", label: t('card.learned'), content: summary.learned, icon: "/icon-thick-learned.svg" },
    { key: "completed", label: t('card.completed'), content: summary.completed, icon: "/icon-thick-completed.svg" },
    { key: "next_steps", label: t('card.nextSteps'), content: summary.next_steps, icon: "/icon-thick-next-steps.svg" },
  ].filter((section) => section.content);

  return (
    <article className="card summary-card">
      <header className="summary-card-header">
        <div className="summary-badge-row">
          <span className="card-type summary-badge">{t('card.sessionSummary')}</span>
          <span className={`card-source source-${summary.platform_source || 'claude'}`}>
            {summary.platform_source || 'claude'}
          </span>
          <span className="summary-project-badge">{summary.project}</span>
        </div>
        {summary.request && (
          <h2 className="summary-title">{summary.request}</h2>
        )}
      </header>

      <div className="summary-sections">
        {sections.map((section, index) => (
          <section
            key={section.key}
            className="summary-section"
            style={{ animationDelay: `${index * 50}ms` }}
          >
            <div className="summary-section-header">
              <img
                src={section.icon}
                alt={section.label}
                className={`summary-section-icon summary-section-icon--${section.key}`}
              />
              <h3 className="summary-section-label">{section.label}</h3>
            </div>
            <div className="summary-section-content">
              {section.content}
            </div>
          </section>
        ))}
      </div>

      <footer className="summary-card-footer">
        <span className="summary-meta-id">{t('card.session')}{summary.id}</span>
        <span className="summary-meta-divider">•</span>
        <time className="summary-meta-date" dateTime={new Date(summary.created_at_epoch).toISOString()}>
          {date}
        </time>
      </footer>
    </article>
  );
}
