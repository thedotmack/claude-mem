import React, { useMemo } from 'react';
import { Plan } from '../types';

interface PlanningBoardProps {
  plans: Plan[];
}

function PlanCard({ plan }: { plan: Plan }) {
  const goals = plan.goals ? JSON.parse(plan.goals) : [];
  const phases = plan.phases ? JSON.parse(plan.phases) : [];
  const updatedAt = plan.updated_at_epoch
    ? new Date(plan.updated_at_epoch).toLocaleString()
    : new Date(plan.created_at_epoch).toLocaleString();

  const statusClass = `collab-plan-status-${plan.status}`;

  return (
    <div className={`collab-plan-card ${statusClass}`}>
      <div className="collab-plan-header">
        <span className="collab-plan-title">{plan.title}</span>
        <span className={`collab-badge collab-badge-plan-${plan.status}`}>{plan.status}</span>
      </div>
      {plan.description && (
        <div className="collab-plan-description">{plan.description}</div>
      )}
      {goals.length > 0 && (
        <div className="collab-plan-goals">
          <div className="collab-plan-label">Goals</div>
          <ul className="collab-plan-goal-list">
            {goals.map((goal: string, i: number) => (
              <li key={i}>{goal}</li>
            ))}
          </ul>
        </div>
      )}
      {phases.length > 0 && (
        <div className="collab-plan-phases">
          <div className="collab-plan-label">Phases</div>
          {phases.map((phase: any, i: number) => (
            <div key={i} className="collab-plan-phase">
              <span className="collab-plan-phase-name">{phase.name}</span>
              {phase.assignee && <span className="collab-plan-phase-assignee">{phase.assignee}</span>}
              <span className={`collab-badge collab-badge-phase-${phase.status || 'pending'}`}>
                {phase.status || 'pending'}
              </span>
            </div>
          ))}
        </div>
      )}
      {plan.notes && (
        <div className="collab-plan-notes">{plan.notes}</div>
      )}
      <div className="collab-plan-footer">
        <span>By {plan.created_by || 'unknown'}</span>
        <span>{updatedAt}</span>
      </div>
    </div>
  );
}

export function PlanningBoard({ plans }: PlanningBoardProps) {
  const columns = useMemo(() => {
    const cols: Record<string, Plan[]> = {
      drafting: [],
      active: [],
      completed: [],
      archived: [],
    };
    for (const plan of plans) {
      const col = cols[plan.status] || cols.drafting;
      col.push(plan);
    }
    return cols;
  }, [plans]);

  const columnLabels: Record<string, string> = {
    drafting: 'Drafting',
    active: 'Active',
    completed: 'Completed',
    archived: 'Archived',
  };

  if (plans.length === 0) {
    return <div className="collab-empty" style={{ padding: '40px 20px' }}>No plans yet. Create a plan using the MCP tools to see it here.</div>;
  }

  return (
    <div className="collab-board">
      {Object.entries(columns).map(([status, colPlans]) => (
        <div key={status} className="collab-board-column">
          <div className="collab-board-column-header">
            <span>{columnLabels[status]}</span>
            <span className="collab-count">{colPlans.length}</span>
          </div>
          <div className="collab-board-column-cards">
            {colPlans.map(plan => <PlanCard key={plan.id} plan={plan} />)}
          </div>
        </div>
      ))}
    </div>
  );
}
