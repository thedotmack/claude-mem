import React from "react";
import { Summary } from "../types";
import { formatDate } from "../utils/formatters";

// Return a CSS class for platform-specific coloring
function platformColorClass(platform: string): string {
  const p = platform.toLowerCase();
  if (p.includes('claude')) return 'badge-platform--claude';
  if (p.includes('cursor')) return 'badge-platform--cursor';
  return 'badge-platform--raw';
}

interface SummaryCardProps {
  summary: Summary;
}

export function SummaryCard({ summary }: SummaryCardProps) {
  const date = formatDate(summary.created_at_epoch);
  const hasProvenance = summary.node || summary.platform || summary.instance;

  const sections = [
    { key: "investigated", label: "Investigated", content: summary.investigated, icon: "/icon-thick-investigated.svg" },
    { key: "learned", label: "Learned", content: summary.learned, icon: "/icon-thick-learned.svg" },
    { key: "completed", label: "Completed", content: summary.completed, icon: "/icon-thick-completed.svg" },
    { key: "next_steps", label: "Next Steps", content: summary.next_steps, icon: "/icon-thick-next-steps.svg" },
  ].filter((section) => section.content);

  return (
    <article className="card summary-card">
      <header className="summary-card-header">
        <div className="summary-badge-row">
          <span className="card-type summary-badge">Session Summary</span>
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
        <span className="summary-meta-id">Session #{summary.id}</span>
        <span className="summary-meta-divider">•</span>
        <time className="summary-meta-date" dateTime={new Date(summary.created_at_epoch).toISOString()}>
          {date}
        </time>
        {hasProvenance && (
          <>
            <span className="summary-meta-divider">·</span>
            {summary.node && (
              <span className="badge-node" title={summary.node}>
                <svg className="badge-node-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
                {summary.node}
              </span>
            )}
            {summary.platform && (
              <span className={`badge-platform ${platformColorClass(summary.platform)}`}>
                {summary.platform}
              </span>
            )}
            {summary.instance && (
              <span className="badge-instance" title={`Instance: ${summary.instance}`}>
                {summary.instance}
              </span>
            )}
          </>
        )}
      </footer>
    </article>
  );
}
