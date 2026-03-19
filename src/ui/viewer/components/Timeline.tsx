import React, { useMemo } from 'react';
import { Observation, AgentMessage, Plan } from '../types';

interface TimelineProps {
  observations: Observation[];
  messages: AgentMessage[];
  plans: Plan[];
}

type TimelineEvent = {
  id: string;
  type: 'observation' | 'message' | 'plan';
  timestamp: number;
  agent: string;
  title: string;
  detail?: string;
  badge: string;
  badgeClass: string;
};

function formatTime(epoch: number): string {
  const d = new Date(epoch);
  const now = new Date();
  const diffMs = now.getTime() - epoch;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return d.toLocaleDateString();
}

function formatDate(epoch: number): string {
  return new Date(epoch).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function Timeline({ observations, messages, plans }: TimelineProps) {
  const events = useMemo<TimelineEvent[]>(() => {
    const items: TimelineEvent[] = [];

    for (const o of observations) {
      items.push({
        id: `obs-${o.id}`,
        type: 'observation',
        timestamp: o.created_at_epoch,
        agent: o.project || 'unknown',
        title: o.title || o.type,
        detail: o.narrative?.slice(0, 120),
        badge: o.type.toUpperCase(),
        badgeClass: 'collab-badge-observation',
      });
    }

    for (const m of messages) {
      items.push({
        id: `msg-${m.id}`,
        type: 'message',
        timestamp: m.created_at_epoch,
        agent: m.from_agent,
        title: `${m.from_agent} → ${m.to_agent}: ${m.subject}`,
        detail: m.body?.slice(0, 120),
        badge: m.urgent ? 'URGENT' : 'MESSAGE',
        badgeClass: m.urgent ? 'collab-badge-urgent' : 'collab-badge-message',
      });
    }

    for (const p of plans) {
      items.push({
        id: `plan-${p.id}`,
        type: 'plan',
        timestamp: p.updated_at_epoch || p.created_at_epoch,
        agent: p.created_by || 'unknown',
        title: p.title,
        detail: p.description?.slice(0, 120),
        badge: p.status.toUpperCase(),
        badgeClass: `collab-badge-plan-${p.status}`,
      });
    }

    items.sort((a, b) => b.timestamp - a.timestamp);
    return items;
  }, [observations, messages, plans]);

  // Group events by date
  const grouped = useMemo(() => {
    const groups: Record<string, TimelineEvent[]> = {};
    for (const event of events) {
      const dateKey = formatDate(event.timestamp);
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(event);
    }
    return groups;
  }, [events]);

  if (events.length === 0) {
    return <div className="collab-empty" style={{ padding: '40px 20px' }}>No timeline events yet. Start collaborating to see activity here.</div>;
  }

  return (
    <div className="collab-timeline">
      {Object.entries(grouped).map(([date, dayEvents]) => (
        <div key={date} className="collab-timeline-group">
          <div className="collab-timeline-date">{date}</div>
          {dayEvents.map(event => (
            <div key={event.id} className="collab-timeline-event">
              <div className="collab-timeline-dot" data-type={event.type} />
              <div className="collab-timeline-content">
                <div className="collab-timeline-header">
                  <span className={`collab-badge ${event.badgeClass}`}>{event.badge}</span>
                  <span className="collab-timeline-time">{formatTime(event.timestamp)}</span>
                </div>
                <div className="collab-timeline-title">{event.title}</div>
                {event.detail && <div className="collab-timeline-detail">{event.detail}</div>}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
