// Background "agent" sessions — ask → running → done.
//
// Ported from /tmp/cmem-redesign/cmem-viewer/search-agent.jsx:112-146.
// The synthesis is local/simulated (see data/search.ts) — there is no
// server agent endpoint. The setTimeout staging just fakes "thinking".
// Browser timers/Date.now are fine here: this is browser runtime code.

import { useCallback, useRef, useState } from 'react';
import { searchMemory, synthesizeAnswer, type SynthesizedAnswer } from '../data/search.js';
import type { ViewerData } from '../data/viewer-types.js';

export type AgentSessionStatus = 'running' | 'done';

export interface AgentSession {
  id: string;
  query: string;
  status: AgentSessionStatus;
  stage: string;
  answer: SynthesizedAnswer | null;
  viewed: boolean;
  /** id of the note this answer was saved as, if any */
  savedNoteId?: string;
  /** set when a done+viewed toast should stop showing */
  dismissedAfterView?: boolean;
}

export interface UseAgentSessions {
  sessions: AgentSession[];
  ask: (query: string) => string;
  dismiss: (id: string) => void;
  markViewed: (id: string) => void;
}

export function useAgentSessions(data: ViewerData): UseAgentSessions {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const idRef = useRef(0);

  const ask = useCallback(
    (query: string): string => {
      const id = 'agent-' + ++idRef.current + '-' + Date.now();
      const matches = searchMemory(query, data).observations.length;
      setSessions((prev) => [
        ...prev,
        { id, query, status: 'running', stage: 'Searching memory…', answer: null, viewed: false },
      ]);

      const stages: [number, string][] = [
        [900, `Reading ${Math.max(matches, 2)} observations…`],
        [2300, 'Composing answer…'],
      ];
      stages.forEach(([delay, stage]) => {
        setTimeout(() => {
          setSessions((prev) =>
            prev.map((s) => (s.id === id && s.status === 'running' ? { ...s, stage } : s))
          );
        }, delay);
      });
      setTimeout(() => {
        const answer = synthesizeAnswer(query, data);
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, status: 'done', stage: 'Answer ready', answer } : s))
        );
      }, 3600);
      return id;
    },
    [data]
  );

  const dismiss = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const markViewed = useCallback((id: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, viewed: true } : s)));
  }, []);

  return { sessions, ask, dismiss, markViewed };
}
