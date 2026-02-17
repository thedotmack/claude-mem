import React, { useState } from "react";
import type { Summary } from "../types";
import { formatDate } from "../utils/formatters";

interface SummaryCardProps {
  summary: Summary;
}

export interface SummarySection {
  key: string;
  label: string;
  content: string;
  icon: string;
}

/**
 * Returns the default expand/collapse state for each summary section.
 * - "completed" and "next_steps" are expanded by default.
 * - "investigated" and "learned" are collapsed by default.
 */
export function getDefaultExpandedSections(): Record<string, boolean> {
  return {
    investigated: false,
    learned: false,
    completed: true,
    next_steps: true,
  };
}

/**
 * Builds the ordered list of sections for a summary, filtering out empty ones.
 * Returns a new array and does not mutate the input summary.
 */
export function buildSections(summary: Summary): SummarySection[] {
  const candidates: SummarySection[] = [
    {
      key: "investigated",
      label: "Investigated",
      content: summary.investigated ?? "",
      icon: "/icon-thick-investigated.svg",
    },
    {
      key: "learned",
      label: "Learned",
      content: summary.learned ?? "",
      icon: "/icon-thick-learned.svg",
    },
    {
      key: "completed",
      label: "Completed",
      content: summary.completed ?? "",
      icon: "/icon-thick-completed.svg",
    },
    {
      key: "next_steps",
      label: "Next Steps",
      content: summary.next_steps ?? "",
      icon: "/icon-thick-next-steps.svg",
    },
  ];

  return candidates.filter((section) => section.content.length > 0);
}

/**
 * Returns a new state record with the given section key toggled.
 * Does not mutate the input state.
 */
export function toggleSection(
  state: Record<string, boolean>,
  key: string,
): Record<string, boolean> {
  return {
    ...state,
    [key]: !state[key],
  };
}

export function SummaryCard({ summary }: SummaryCardProps) {
  const date = formatDate(summary.created_at_epoch);
  const sections = buildSections(summary);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>(
    getDefaultExpandedSections,
  );

  const handleToggle = (key: string) => {
    setExpandedSections((prev) => toggleSection(prev, key));
  };

  return (
    <article className="card summary-card" data-testid="summary-card">
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
        {sections.map((section, index) => {
          const isExpanded = expandedSections[section.key] ?? false;
          return (
            <section
              key={section.key}
              className="summary-section"
              data-testid="summary-section"
              data-section-key={section.key}
              aria-expanded={isExpanded}
              style={{ animationDelay: `${String(index * 50)}ms` }}
            >
              <div
                className="summary-section-header"
                data-testid="summary-section-header"
                onClick={() => { handleToggle(section.key); }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleToggle(section.key);
                  }
                }}
              >
                <img
                  src={section.icon}
                  alt={section.label}
                  className={`summary-section-icon summary-section-icon--${section.key}`}
                />
                <h3 className="summary-section-label">{section.label}</h3>
                <span
                  className={`summary-section-chevron${isExpanded ? " summary-section-chevron--expanded" : ""}`}
                  aria-hidden="true"
                >
                  ▾
                </span>
              </div>
              <div
                className="summary-section-content"
                style={{
                  maxHeight: isExpanded ? "500px" : "0",
                  overflow: "hidden",
                }}
              >
                {section.content}
              </div>
            </section>
          );
        })}
      </div>

      <footer className="summary-card-footer">
        <span className="summary-meta-id">Session #{summary.id}</span>
        <span className="summary-meta-divider">•</span>
        <time
          className="summary-meta-date"
          dateTime={new Date(summary.created_at_epoch).toISOString()}
        >
          {date}
        </time>
      </footer>
    </article>
  );
}
