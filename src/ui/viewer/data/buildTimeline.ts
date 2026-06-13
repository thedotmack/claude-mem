// CMEM Viewer — timeline builder (days -> sessions -> observations).
// Ported from /tmp/cmem-redesign/cmem-viewer/app-v4.jsx:18-55.
// Source used array filters (types/concepts); the production signature uses
// Set<string> per the redesign plan — logic is equivalent (size/has).

import { fmtDayKey } from '../utils/format';
import type {
  ViewerData,
  ViewerObservation,
  ViewerPrompt,
  ViewerSession
} from './viewer-types';

export interface TimelineFilters {
  project?: string;
  types?: Set<string>;
  concepts?: Set<string>;
  file?: string | null;
}

/** A session with its (filtered, time-sorted) observations and originating prompt. */
export interface TimelineSession {
  session: ViewerSession;
  prompt?: ViewerPrompt;
  observations: ViewerObservation[];
}

/** A day bucket: a day-key, its lead epoch, and the sessions within it. */
export interface DayGroup {
  key: string;
  epoch: number;
  sessions: TimelineSession[];
}

export function buildTimeline(data: ViewerData, filters: TimelineFilters): DayGroup[] {
  const { project, types, concepts, file } = filters;

  const obsMatch = (o: ViewerObservation): boolean => {
    if (project && o.project !== project) return false;
    if (types && types.size && !types.has(o.type)) return false;
    if (concepts && concepts.size && !o.concepts.some((c) => concepts.has(c))) return false;
    if (file && !(o.files_read.includes(file) || o.files_modified.includes(file))) return false;
    return true;
  };

  const bySession: Record<string, ViewerObservation[]> = {};
  data.observations.filter(obsMatch).forEach((o) => {
    (bySession[o.session_id] = bySession[o.session_id] || []).push(o);
  });

  const promptBySession: Record<string, ViewerPrompt> = Object.fromEntries(
    data.prompts.map((p) => [p.session_id, p])
  );

  const groups: TimelineSession[] = data.sessions
    .filter((s) => bySession[s.id])
    .map((s) => ({
      session: s,
      prompt: promptBySession[s.id],
      observations: bySession[s.id].sort((a, b) => a.at - b.at)
    }));

  const byDay: Record<string, TimelineSession[]> = {};
  groups.forEach((g) => {
    const key = fmtDayKey(g.session.started);
    (byDay[key] = byDay[key] || []).push(g);
  });

  return Object.entries(byDay)
    .map(([key, sessions]) => ({
      key,
      epoch: sessions[0].session.started,
      sessions: sessions.sort((a, b) => b.session.started - a.session.started)
    }))
    .sort((a, b) => b.epoch - a.epoch);
}
