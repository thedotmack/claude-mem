// ============================================================
// CMEM Viewer — collapsible timeline
// Day -> Session -> Observation, every level collapsible.
// Ported from /tmp/cmem-redesign/cmem-viewer/timeline.jsx (no window globals).
// ============================================================

import React from 'react';
import { Icon, TYPE_META } from '../ui/icons';
import { fmtTime, fmtDayLabel, baseName } from '../utils/format';
import type { DayGroup as DayGroupData, TimelineSession } from '../data/buildTimeline';
import type { ViewerObservation } from '../data/viewer-types';

// ---------- Concept chip ----------
interface ConceptChipProps {
  concept: string;
  active: boolean;
  onClick: (concept: string) => void;
}

export function ConceptChip({ concept, active, onClick }: ConceptChipProps) {
  return (
    <button
      className={'concept-chip' + (active ? ' active' : '')}
      onClick={(e) => { e.stopPropagation(); onClick(concept); }}
    >{concept}</button>
  );
}

// ---------- File chip ----------
interface FileChipProps {
  path: string;
  mode: 'read' | 'modified';
  onClick: (filepath: string) => void;
}

export function FileChip({ path, mode, onClick }: FileChipProps) {
  return (
    <button className="file-chip" title={path} onClick={(e) => { e.stopPropagation(); onClick(path); }}>
      <Icon name={mode === 'modified' ? 'pencil' : 'eye'} size={12} />
      <span>{baseName(path)}</span>
    </button>
  );
}

// ---------- Observation row ----------
interface ObservationRowProps {
  obs: ViewerObservation;
  open: boolean;
  onToggle: (obsId: number) => void;
  activeConcepts: string[];
  onConceptClick: (concept: string) => void;
  onFileClick: (filepath: string) => void;
  flash: boolean;
}

export function ObservationRow({
  obs, open, onToggle, activeConcepts, onConceptClick, onFileClick, flash
}: ObservationRowProps) {
  const meta = TYPE_META[obs.type] || TYPE_META.feature;
  return (
    <div
      className={'obs-row' + (open ? ' open' : '') + (flash ? ' flash' : '')}
      id={'obs-' + obs.id}
      data-comment-anchor={'obs-' + obs.id}
    >
      <button className="obs-head" onClick={() => onToggle(obs.id)} aria-expanded={open}>
        <span className="obs-type-bubble" style={{ background: meta.bg, color: meta.fg }}>
          <Icon name={meta.icon} size={15} />
        </span>
        <span className="obs-head-text">
          <span className="obs-title">{obs.title}</span>
          {!open && obs.subtitle && <span className="obs-subtitle">{obs.subtitle}</span>}
        </span>
        <span className="obs-head-meta">
          <span className="obs-time">{fmtTime(obs.at)}</span>
          <Icon name="chevronDown" size={15} className={'obs-caret' + (open ? ' rot' : '')} />
        </span>
      </button>

      {open && (
        <div className="obs-body">
          {obs.subtitle && <p className="obs-body-subtitle">{obs.subtitle}</p>}
          {obs.facts.length > 0 && (
            <ul className="facts-list">
              {obs.facts.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          )}
          {obs.narrative && <p className="obs-narrative">{obs.narrative}</p>}
          <div className="obs-foot">
            <div className="obs-chips">
              {obs.concepts.map((c) => (
                <ConceptChip key={c} concept={c} active={activeConcepts.includes(c)} onClick={onConceptClick} />
              ))}
              {obs.files_modified.map((f) => <FileChip key={'m' + f} path={f} mode="modified" onClick={onFileClick} />)}
              {obs.files_read.filter((f) => !obs.files_modified.includes(f)).map((f) => (
                <FileChip key={'r' + f} path={f} mode="read" onClick={onFileClick} />
              ))}
            </div>
            <span className="obs-id">#{obs.id}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Session card ----------
interface SessionCardProps {
  group: TimelineSession;
  open: boolean;
  onToggle: (sessionId: string) => void;
  openObs: Record<string | number, boolean>;
  onToggleObs: (obsId: number) => void;
  activeConcepts: string[];
  onConceptClick: (concept: string) => void;
  onFileClick: (filepath: string) => void;
  flashId: number | null;
}

export function SessionCard({
  group, open, onToggle, openObs, onToggleObs,
  activeConcepts, onConceptClick, onFileClick, flashId
}: SessionCardProps) {
  const { session, prompt, observations } = group;
  const obsCount = observations.length;
  return (
    <div className={'session-card' + (open ? ' open' : '')} id={'sess-' + session.id} data-screen-label={'Session ' + session.id}>
      <button className="session-head" onClick={() => onToggle(session.id)} aria-expanded={open}>
        <Icon name="chevronDown" size={17} className={'session-caret' + (open ? ' rot' : '')} />
        <div className="session-head-text">
          <span className="session-title">{session.request}</span>
          <span className="session-meta">
            <span className={'project-dot p-' + session.project}></span>
            {session.project}
            <span className="dot-sep">·</span>
            {fmtTime(session.started)}–{fmtTime(session.ended)}
            <span className="dot-sep">·</span>
            {obsCount} {obsCount === 1 ? 'memory' : 'memories'}
          </span>
        </div>
        {!open && (
          <div className="session-type-peek">
            {[...new Set(observations.map((o) => o.type))].slice(0, 4).map((t) => {
              const m = TYPE_META[t] || TYPE_META.feature;
              return (
                <span key={t} className="peek-bubble" style={{ background: m.bg, color: m.fg }} title={m.label}>
                  <Icon name={m.icon} size={12} />
                </span>
              );
            })}
          </div>
        )}
      </button>

      {open && (
        <div className="session-body">
          {prompt && (
            <div className="prompt-bubble">
              <span className="prompt-avatar"><Icon name="user" size={13} /></span>
              <p>{prompt.text}</p>
            </div>
          )}
          <div className="obs-list">
            {observations.map((o) => (
              <ObservationRow
                key={o.id} obs={o}
                open={!!openObs[o.id]} onToggle={onToggleObs}
                activeConcepts={activeConcepts}
                onConceptClick={onConceptClick} onFileClick={onFileClick}
                flash={flashId === o.id}
              />
            ))}
          </div>
          {(session.learned || session.completed || session.next_steps) && (
            <div className="session-summary">
              {session.learned && (
                <div className="summary-row">
                  <span className="summary-key"><Icon name="lightbulb" size={13} /> learned</span>
                  <p>{session.learned}</p>
                </div>
              )}
              {session.completed && (
                <div className="summary-row">
                  <span className="summary-key"><Icon name="check" size={13} /> completed</span>
                  <p>{session.completed}</p>
                </div>
              )}
              {session.next_steps && (
                <div className="summary-row">
                  <span className="summary-key"><Icon name="arrowRight" size={13} /> next steps</span>
                  <p>{session.next_steps}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Day group ----------
interface DayGroupProps {
  day: DayGroupData;
  open: boolean;
  onToggle: (key: string) => void;
  openSessions: Record<string, boolean>;
  onToggleSession: (sessionId: string) => void;
  openObs: Record<string | number, boolean>;
  onToggleObs: (obsId: number) => void;
  activeConcepts: string[];
  onConceptClick: (concept: string) => void;
  onFileClick: (filepath: string) => void;
  flashId: number | null;
}

export function DayGroup({
  day, open, onToggle, openSessions, onToggleSession, openObs, onToggleObs,
  activeConcepts, onConceptClick, onFileClick, flashId
}: DayGroupProps) {
  const label = fmtDayLabel(day.epoch);
  const totalObs = day.sessions.reduce((n, s) => n + s.observations.length, 0);
  return (
    <section className="day-group" id={'day-' + day.key} data-screen-label={label.lead + ' ' + label.rest}>
      <button className="day-head" onClick={() => onToggle(day.key)} aria-expanded={open}>
        <span className="day-rail-dot"></span>
        <h2 className="day-title">
          {label.lead}
          <span className="day-title-rest">{label.rest}</span>
        </h2>
        <span className="day-meta">
          {day.sessions.length} {day.sessions.length === 1 ? 'session' : 'sessions'} · {totalObs} memories
        </span>
        <Icon name="chevronDown" size={18} className={'day-caret' + (open ? ' rot' : '')} />
      </button>
      {open && (
        <div className="day-body">
          {day.sessions.map((g) => (
            <SessionCard
              key={g.session.id} group={g}
              open={!!openSessions[g.session.id]} onToggle={onToggleSession}
              openObs={openObs} onToggleObs={onToggleObs}
              activeConcepts={activeConcepts}
              onConceptClick={onConceptClick} onFileClick={onFileClick}
              flashId={flashId}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- Timeline root ----------
export interface TimelineProps {
  days: DayGroupData[];
  openDays: Record<string, boolean>;
  onToggleDay: (key: string) => void;
  openSessions: Record<string, boolean>;
  onToggleSession: (sessionId: string) => void;
  openObs: Record<string | number, boolean>;
  onToggleObs: (obsId: number) => void;
  activeConcepts: string[];
  onConceptClick: (concept: string) => void;
  onFileClick: (filepath: string) => void;
  flashId: number | null;
}

export function Timeline(props: TimelineProps) {
  const { days } = props;
  if (days.length === 0) {
    return (
      <div className="timeline-empty">
        <Icon name="brain" size={38} strokeWidth={1.6} />
        <p className="empty-title">Nothing remembered here yet</p>
        <p className="empty-sub">Try clearing a filter, or ask your agent instead.</p>
      </div>
    );
  }
  return (
    <div className="timeline">
      {days.map((day) => (
        <DayGroup
          key={day.key} day={day}
          open={!!props.openDays[day.key]} onToggle={props.onToggleDay}
          openSessions={props.openSessions} onToggleSession={props.onToggleSession}
          openObs={props.openObs} onToggleObs={props.onToggleObs}
          activeConcepts={props.activeConcepts}
          onConceptClick={props.onConceptClick} onFileClick={props.onFileClick}
          flashId={props.flashId}
        />
      ))}
    </div>
  );
}

export default Timeline;
