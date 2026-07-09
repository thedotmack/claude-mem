// CMEM Viewer — v4 app shell.
// Ported from /tmp/cmem-redesign/cmem-viewer/app-v4.jsx:317-682, wired to the
// production data layer (useViewerData) and real features (settings, logs,
// welcome). Filters use Set<string> per buildTimeline's production signature.
// No window globals; all data flows through ES imports.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Header } from './components/Header';
import { ChipsBar } from './components/ChipsBar';
import { DateRail } from './components/DateRail';
import { ContextBar } from './components/ContextBar';
import { Timeline } from './components/Timeline';
import { Sidebar } from './components/Sidebar';
import { AnswerDrawer, type DrawerTarget } from './components/AnswerDrawer';
import { AgentPanel } from './components/AgentPanel';
import { AgentToasts } from './components/AgentToasts';
import { TweaksPopover, useTweaks } from './components/TweaksPopover';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { WelcomeCard, getStoredWelcomeDismissed, setStoredWelcomeDismissed } from './components/WelcomeCard';
import { Icon } from './ui/icons';
import { useViewerData } from './hooks/useViewerData';
import { useAgentSessions, type AgentSession } from './hooks/useAgentSessions';
import { useNotes } from './hooks/useNotes';
import { useSettings } from './hooks/useSettings';
import { useStats } from './hooks/useStats';
import { buildTimeline } from './data/buildTimeline';
import { fmtDayKey } from './utils/format';

interface Filters {
  project: string;
  types: Set<string>;
  concepts: Set<string>;
  file: string | null;
}

export function App() {
  // ---------- data + real features ----------
  const [currentFilter, setCurrentFilter] = useState('');
  const { data, projects, isProcessing, queueDepth, isConnected } = useViewerData(currentFilter);
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { refreshStats } = useStats();
  const { tweaks, setTweak } = useTweaks();

  const agent = useAgentSessions(data);
  const { notes, saveNote, deleteNote } = useNotes(data.seedNotes);

  // ---------- shell state ----------
  const [filters, setFilters] = useState<Filters>({
    project: '',
    types: new Set<string>(),
    concepts: new Set<string>(),
    file: null
  });
  const [openDays, setOpenDays] = useState<Record<string, boolean> | null>(null);
  const [openSessions, setOpenSessions] = useState<Record<string, boolean> | null>(null);
  const [openObs, setOpenObs] = useState<Record<string | number, boolean>>({});
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [activeDayKey, setActiveDayKey] = useState<string | null>(null);
  const [ctxSessionId, setCtxSessionId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const [savedMap, setSavedMap] = useState<Record<string, string>>({});

  // ---------- modal / popover flags ----------
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean>(getStoredWelcomeDismissed);

  // keep currentFilter (project) in sync with filters.project
  useEffect(() => {
    setCurrentFilter(filters.project);
  }, [filters.project]);

  // reset project filter if the selected project disappears
  useEffect(() => {
    if (filters.project && !projects.includes(filters.project)) {
      setFilters((f) => ({ ...f, project: '' }));
    }
  }, [projects, filters.project]);

  // ---------- derived timeline ----------
  const days = useMemo(
    () =>
      buildTimeline(data, {
        project: filters.project || undefined,
        types: filters.types,
        concepts: filters.concepts,
        file: filters.file
      }),
    [data, filters]
  );

  const citedObs = useMemo(
    () => Object.fromEntries(data.observations.map((o) => [o.id, o])),
    [data]
  );

  // project header stats (project filter only — chip/file filters don't shrink)
  const projStats = useMemo(() => {
    const obs = data.observations.filter((o) => !filters.project || o.project === filters.project);
    const sess = new Set(obs.map((o) => o.session_id));
    const files = new Set<string>();
    obs.forEach((o) => {
      o.files_read.forEach((f) => files.add(f));
      o.files_modified.forEach((f) => files.add(f));
    });
    let range: string | null = null;
    if (obs.length) {
      const fmt = (e: number) => new Date(e * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
      const min = obs.reduce((m, o) => Math.min(m, o.at), Infinity);
      const max = obs.reduce((m, o) => Math.max(m, o.at), -Infinity);
      range = fmt(min) === fmt(max) ? fmt(max) : fmt(min) + ' – ' + fmt(max);
    }
    return { mem: obs.length, sessions: sess.size, files: files.size, range };
  }, [data, filters.project]);

  const ctxGroup = useMemo(() => {
    if (!ctxSessionId) return null;
    for (const d of days) {
      const g = d.sessions.find((x) => String(x.session.id) === ctxSessionId);
      if (g) return g;
    }
    return null;
  }, [ctxSessionId, days]);

  // default open state: most recent day + its most recent session
  const effOpenDays = useMemo<Record<string, boolean>>(() => {
    if (openDays) return openDays;
    return days.length ? { [days[0].key]: true } : {};
  }, [openDays, days]);
  const effOpenSessions = useMemo<Record<string, boolean>>(() => {
    if (openSessions) return openSessions;
    return days.length && days[0].sessions.length ? { [days[0].sessions[0].session.id]: true } : {};
  }, [openSessions, days]);

  const filterSig =
    [...filters.types].join(',') + '|' + [...filters.concepts].join(',') + '|' + (filters.file || '');
  const filterActive = filters.types.size > 0 || filters.concepts.size > 0 || !!filters.file;
  const shownCount = days.reduce(
    (n, d) => n + d.sessions.reduce((m, g) => m + g.observations.length, 0),
    0
  );

  // when a narrowing filter engages, open everything that survived it
  useEffect(() => {
    if (!filterActive) return;
    const d: Record<string, boolean> = {};
    const s: Record<string, boolean> = {};
    days.forEach((day) => {
      d[day.key] = true;
      day.sessions.forEach((g) => {
        s[g.session.id] = true;
      });
    });
    setOpenDays(d);
    setOpenSessions(s);
    // Intentionally keyed on filterSig only, not `days`: we expand-all once when the
    // filter changes (days is recomputed synchronously in the same render via useMemo,
    // so the snapshot read here is current). We deliberately do NOT depend on `days` —
    // re-running on every SSE data tick while a filter is active would clobber the
    // user's manual collapses. New rows arriving under an active filter stay collapsed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSig]);

  // refresh stats when the observation count changes
  useEffect(() => {
    refreshStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.observations.length]);

  // ---------- scroll-spy: date rail + docked context header ----------
  useEffect(() => {
    const spy = () => {
      const sections = document.querySelectorAll('.day-group');
      let cur: string | null = null;
      sections.forEach((el) => {
        if (el.getBoundingClientRect().top <= 200) cur = el.id.replace('day-', '');
      });
      if (!cur && sections.length) cur = sections[0].id.replace('day-', '');
      setActiveDayKey(cur);

      const cards = document.querySelectorAll('.session-card');
      let sess: string | null = null;
      cards.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.top <= 168 && r.bottom > 120) sess = el.id.replace('sess-', '');
      });
      setCtxSessionId(sess);
    };
    spy();
    window.addEventListener('scroll', spy, { passive: true });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(spy);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(spy);
      ro.observe(document.body);
    }
    return () => {
      window.removeEventListener('scroll', spy);
      if (ro) ro.disconnect();
    };
  }, [days]);

  // ---------- toggles ----------
  const setAll = useCallback(
    (open: boolean) => {
      const d: Record<string, boolean> = {};
      const s: Record<string, boolean> = {};
      days.forEach((day) => {
        d[day.key] = open;
        day.sessions.forEach((g) => {
          s[g.session.id] = open;
        });
      });
      setOpenDays(d);
      setOpenSessions(s);
      if (!open) setOpenObs({});
    },
    [days]
  );

  const toggleDay = useCallback(
    (k: string) => setOpenDays((prev) => ({ ...(prev || effOpenDays), [k]: !(prev || effOpenDays)[k] })),
    [effOpenDays]
  );
  const toggleSession = useCallback(
    (k: string) =>
      setOpenSessions((prev) => ({ ...(prev || effOpenSessions), [k]: !(prev || effOpenSessions)[k] })),
    [effOpenSessions]
  );
  const toggleObs = useCallback(
    (id: number) => setOpenObs((p) => ({ ...p, [id]: !p[id] })),
    []
  );

  // ---------- filter helpers ----------
  const toggleType = useCallback((t: string) => {
    setFilters((f) => {
      const types = new Set(f.types);
      types.has(t) ? types.delete(t) : types.add(t);
      return { ...f, types };
    });
  }, []);
  const toggleConcept = useCallback((c: string) => {
    setFilters((f) => {
      const concepts = new Set(f.concepts);
      concepts.has(c) ? concepts.delete(c) : concepts.add(c);
      return { ...f, concepts };
    });
  }, []);
  const addConcept = useCallback((c: string) => {
    setFilters((f) => {
      if (f.concepts.has(c)) return f;
      const concepts = new Set(f.concepts);
      concepts.add(c);
      return { ...f, concepts };
    });
  }, []);
  const setFile = useCallback((file: string | null) => {
    setFilters((f) => ({ ...f, file: f.file === file ? null : file }));
  }, []);
  const clearChips = useCallback(() => {
    setFilters((f) => ({ ...f, types: new Set<string>(), concepts: new Set<string>() }));
  }, []);
  const clearAll = useCallback(() => {
    setFilters((f) => ({ ...f, types: new Set<string>(), concepts: new Set<string>(), file: null }));
  }, []);

  // ---------- jump / scroll ----------
  const jumpToDay = useCallback(
    (key: string) => {
      setOpenDays((prev) => ({ ...(prev || effOpenDays), [key]: true }));
      setActiveDayKey(key);
      setTimeout(() => {
        const el = document.getElementById('day-' + key);
        if (el) {
          const top = el.getBoundingClientRect().top + window.scrollY - 132;
          window.scrollTo({ top, behavior: 'smooth' });
        }
      }, 60);
    },
    [effOpenDays]
  );

  const jumpTo = useCallback(
    (obsId: number) => {
      const o = data.observations.find((x) => x.id === obsId);
      if (!o) return;
      // Day groups are bucketed by the owning session's start time (see buildTimeline),
      // not the observation's own timestamp — use the session's started so jumps into
      // sessions that span midnight open the correct day group.
      const sess = data.sessions.find((s) => s.id === o.session_id);
      const dayKey = fmtDayKey(sess ? sess.started : o.at);
      setFilters({ project: '', types: new Set<string>(), concepts: new Set<string>(), file: null });
      setOpenDays((prev) => ({ ...(prev || effOpenDays), [dayKey]: true }));
      setOpenSessions((prev) => ({ ...(prev || effOpenSessions), [o.session_id]: true }));
      setOpenObs((p) => ({ ...p, [obsId]: true }));
      setDrawer(null);
      setAgentOpen(false);
      setFlashId(obsId);
      setTimeout(() => {
        const el = document.getElementById('obs-' + obsId);
        if (el) {
          const top = el.getBoundingClientRect().top + window.scrollY - 170;
          window.scrollTo({ top, behavior: 'smooth' });
        }
      }, 80);
      setTimeout(() => setFlashId(null), 2400);
    },
    [data, effOpenDays, effOpenSessions]
  );

  // ---------- agent / notes ----------
  // Asking opens the interactive agent panel; the ask becomes a new turn in
  // the conversation thread. Note drawer closes so panels never stack.
  const handleAsk = useCallback((query: string) => {
    agent.ask(query);
    setDrawer(null);
    setAgentOpen(true);
  }, [agent]);

  const openAgentAnswer = useCallback(
    (id: string) => {
      setDrawer(null);
      setAgentOpen(true);
      setTimeout(() => agent.markViewed(id), 4000);
    },
    [agent]
  );

  // while the panel is open, freshly-answered turns finish their word-reveal
  // then settle (viewed = no re-animation next render)
  const doneUnviewed = agent.sessions
    .filter((s) => s.status === 'done' && !s.viewed)
    .map((s) => s.id)
    .join('|');
  useEffect(() => {
    if (!agentOpen || !doneUnviewed) return;
    const ids = doneUnviewed.split('|');
    const t = setTimeout(() => ids.forEach((id) => agent.markViewed(id)), 4000);
    return () => clearTimeout(t);
  }, [agentOpen, doneUnviewed, agent]);

  const handleSaveNote = useCallback(
    (session: AgentSession) => {
      if (!session.answer) return;
      saveNote({
        title: session.query,
        text: '',
        cited: session.answer.cited,
        blocks: session.answer.blocks
      });
      setSavedMap((m) => ({ ...m, [session.id]: 'saved' }));
    },
    [saveNote]
  );

  const sessionsView = useMemo<AgentSession[]>(
    () => agent.sessions.map((s) => ({ ...s, savedNoteId: savedMap[s.id] || undefined })),
    [agent.sessions, savedMap]
  );

  // ---------- Esc closes overlays ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSideOpen(false);
        setDrawer(null);
        setAgentOpen(false);
        setTweaksOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ---------- root tweak vars (accent / roundness / density) ----------
  // useTweaks applies these to document.documentElement; we also mirror them on
  // the .app element so the styles cascade exactly like the v4 prototype.
  const accent = useMemo(() => {
    return {
      '--rs': String(tweaks.roundness)
    } as React.CSSProperties;
  }, [tweaks.roundness]);

  return (
    <div className="app" data-density={tweaks.density} style={accent}>
      <Header
        data={data}
        projects={projects}
        currentFilter={filters.project}
        onFilterChange={(p) => setFilters((f) => ({ ...f, project: p }))}
        isConnected={isConnected}
        isProcessing={isProcessing}
        queueDepth={queueDepth}
        sideOpen={sideOpen}
        onToggleSide={() => setSideOpen((v) => !v)}
        onAsk={handleAsk}
        onJump={jumpTo}
        onFile={(f) => setFilters((fl) => ({ ...fl, file: f }))}
        onConcept={addConcept}
        onOpenSettings={() => setSettingsOpen(true)}
        onShowHelp={() => {
          setStoredWelcomeDismissed(false);
          setWelcomeDismissed(false);
        }}
        onToggleLogs={() => setLogsOpen((v) => !v)}
        onToggleTweaks={() => setTweaksOpen((v) => !v)}
      />

      <ChipsBar
        data={data}
        filters={filters}
        onToggleType={toggleType}
        onToggleConcept={toggleConcept}
        onClear={clearChips}
      />

      <div className="layout">
        <DateRail days={days} activeKey={activeDayKey} onJump={jumpToDay} />

        <main className="main" data-screen-label="Timeline">
          <ContextBar
            ctxGroup={ctxGroup}
            projectLabel={filters.project || 'All projects'}
            projStats={projStats}
            onExpandAll={() => setAll(true)}
            onCollapseAll={() => setAll(false)}
          />

          {filterActive && (
            <div className="filter-banner">
              <Icon name="search" size={14} />
              <span>
                <strong>{shownCount}</strong> {shownCount === 1 ? 'memory' : 'memories'}
                {filters.file && (
                  <React.Fragment>
                    {' '}touching <code className="mono-inline">{filters.file}</code>
                  </React.Fragment>
                )}
                {filters.concepts.size > 0 && (
                  <React.Fragment>
                    {' '}tagged <strong>{[...filters.concepts].join(', ')}</strong>
                  </React.Fragment>
                )}
                {filters.types.size > 0 && (
                  <React.Fragment> · {[...filters.types].join(' / ')}</React.Fragment>
                )}
              </span>
              <button className="banner-clear" onClick={clearAll}>
                <Icon name="x" size={12} /> Clear
              </button>
            </div>
          )}

          <Timeline
            days={days}
            openDays={effOpenDays}
            onToggleDay={toggleDay}
            openSessions={effOpenSessions}
            onToggleSession={toggleSession}
            openObs={openObs}
            onToggleObs={toggleObs}
            activeConcepts={[...filters.concepts]}
            onConceptClick={toggleConcept}
            onFileClick={setFile}
            flashId={flashId}
          />
        </main>
      </div>

      {sideOpen && (
        <React.Fragment>
          <div className="side-scrim" onClick={() => setSideOpen(false)}></div>
          <div className="side-drawer" role="dialog" aria-label="Files and notes">
            <div className="side-drawer-head">
              <p className="cm-eyebrow side-drawer-title">Files &amp; notes</p>
              <button
                className="icon-btn"
                onClick={() => setSideOpen(false)}
                aria-label="Close files and notes"
              >
                <Icon name="x" size={15} />
              </button>
            </div>
            <div className="side-drawer-body">
              <Sidebar
                data={data}
                project={filters.project}
                activeFile={filters.file}
                onFileClick={setFile}
                notes={notes}
                onOpenNote={(id) => {
                  setSideOpen(false);
                  setAgentOpen(false);
                  setDrawer({ type: 'note', id });
                }}
                activeNoteId={drawer && drawer.type === 'note' ? drawer.id : null}
                onClose={() => setSideOpen(false)}
              />
            </div>
          </div>
        </React.Fragment>
      )}

      <AnswerDrawer
        drawer={drawer}
        agentSessions={sessionsView}
        notes={notes}
        citedObs={citedObs}
        onClose={() => setDrawer(null)}
        onSaveNote={handleSaveNote}
        onDeleteNote={(id) => {
          deleteNote(id);
          setDrawer(null);
        }}
        onCite={jumpTo}
      />

      <AgentPanel
        open={agentOpen}
        sessions={sessionsView}
        citedObs={citedObs}
        onAsk={handleAsk}
        onCite={jumpTo}
        onSaveNote={handleSaveNote}
        onClose={() => setAgentOpen(false)}
      />

      {!agentOpen && (
        <AgentToasts sessions={sessionsView} onOpen={openAgentAnswer} onDismiss={agent.dismiss} />
      )}

      {!welcomeDismissed && <WelcomeCard onDismiss={() => setWelcomeDismissed(true)} />}

      <ContextSettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSave={saveSettings}
        isSaving={isSaving}
        saveStatus={saveStatus}
      />

      <LogsDrawer isOpen={logsOpen} onClose={() => setLogsOpen(false)} />

      <TweaksPopover open={tweaksOpen} onClose={() => setTweaksOpen(false)} tweaks={tweaks} setTweak={setTweak} />
    </div>
  );
}
