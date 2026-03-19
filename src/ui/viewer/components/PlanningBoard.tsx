import React, { useMemo, useState, useCallback } from 'react';
import { Plan } from '../types';
import { API_ENDPOINTS } from '../constants/api';

interface PhaseInput {
  name: string;
  assignee: string;
  status: string;
  tasks: string[];
}

interface PlanningBoardProps {
  plans: Plan[];
  onPlanCreated?: () => void;
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

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function PlanForm({ onSubmit, onCancel }: { onSubmit: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [goals, setGoals] = useState<string[]>(['']);
  const [phases, setPhases] = useState<PhaseInput[]>([{ name: '', assignee: 'claude-code', status: 'pending', tasks: [''] }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = useCallback(async () => {
    if (!title.trim()) { setError('Title is required'); return; }
    setSaving(true);
    setError('');
    try {
      const body = {
        id: slugify(title),
        title: title.trim(),
        description: description.trim() || undefined,
        project: 'claude-x-codex',
        created_by: 'user',
        goals: goals.filter(g => g.trim()),
        phases: phases.filter(p => p.name.trim()).map(p => ({
          name: p.name.trim(),
          assignee: p.assignee,
          status: p.status,
          tasks: p.tasks.filter(t => t.trim()),
        })),
      };
      const res = await fetch(API_ENDPOINTS.PLANS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      onSubmit();
    } catch (e: any) {
      setError(e.message || 'Failed to create plan');
    } finally {
      setSaving(false);
    }
  }, [title, description, goals, phases, onSubmit]);

  const updateGoal = (i: number, val: string) => setGoals(g => g.map((v, j) => j === i ? val : v));
  const addGoal = () => setGoals(g => [...g, '']);
  const removeGoal = (i: number) => setGoals(g => g.filter((_, j) => j !== i));

  const updatePhase = (i: number, field: keyof PhaseInput, val: any) =>
    setPhases(p => p.map((ph, j) => j === i ? { ...ph, [field]: val } : ph));
  const addPhase = () => setPhases(p => [...p, { name: '', assignee: 'claude-code', status: 'pending', tasks: [''] }]);
  const removePhase = (i: number) => setPhases(p => p.filter((_, j) => j !== i));
  const addTask = (pi: number) => setPhases(p => p.map((ph, j) => j === pi ? { ...ph, tasks: [...ph.tasks, ''] } : ph));
  const removeTask = (pi: number, ti: number) => setPhases(p => p.map((ph, j) => j === pi ? { ...ph, tasks: ph.tasks.filter((_, k) => k !== ti) } : ph));
  const updateTask = (pi: number, ti: number, val: string) => setPhases(p => p.map((ph, j) => j === pi ? { ...ph, tasks: ph.tasks.map((t, k) => k === ti ? val : t) } : ph));

  return (
    <div className="plan-form">
      <h3 className="plan-form-title">Create New Plan</h3>
      {error && <div className="plan-form-error">{error}</div>}

      <label className="plan-form-label">Title</label>
      <input className="plan-form-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="Plan title..." />
      {title && <div className="plan-form-slug">ID: {slugify(title)}</div>}

      <label className="plan-form-label">Description</label>
      <textarea className="plan-form-textarea" value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional description..." rows={2} />

      <label className="plan-form-label">Goals</label>
      {goals.map((g, i) => (
        <div key={i} className="plan-form-row">
          <input className="plan-form-input plan-form-flex" value={g} onChange={e => updateGoal(i, e.target.value)} placeholder={`Goal ${i + 1}`} />
          {goals.length > 1 && <button className="plan-form-btn-sm plan-form-btn-danger" onClick={() => removeGoal(i)}>×</button>}
        </div>
      ))}
      <button className="plan-form-btn-sm" onClick={addGoal}>+ Add Goal</button>

      <label className="plan-form-label" style={{ marginTop: 16 }}>Phases</label>
      {phases.map((ph, pi) => (
        <div key={pi} className="plan-form-phase">
          <div className="plan-form-phase-header">
            <span className="plan-form-phase-num">Phase {pi + 1}</span>
            {phases.length > 1 && <button className="plan-form-btn-sm plan-form-btn-danger" onClick={() => removePhase(pi)}>Remove</button>}
          </div>
          <div className="plan-form-row">
            <input className="plan-form-input plan-form-flex" value={ph.name} onChange={e => updatePhase(pi, 'name', e.target.value)} placeholder="Phase name" />
            <select className="plan-form-select" value={ph.assignee} onChange={e => updatePhase(pi, 'assignee', e.target.value)}>
              <option value="claude-code">claude-code</option>
              <option value="codex">codex</option>
              <option value="claude-app">claude-app</option>
              <option value="user">user</option>
            </select>
            <select className="plan-form-select" value={ph.status} onChange={e => updatePhase(pi, 'status', e.target.value)}>
              <option value="pending">pending</option>
              <option value="in-progress">in-progress</option>
              <option value="done">done</option>
            </select>
          </div>
          <div className="plan-form-tasks">
            {ph.tasks.map((t, ti) => (
              <div key={ti} className="plan-form-row">
                <input className="plan-form-input plan-form-flex" value={t} onChange={e => updateTask(pi, ti, e.target.value)} placeholder={`Task ${ti + 1}`} />
                {ph.tasks.length > 1 && <button className="plan-form-btn-sm plan-form-btn-danger" onClick={() => removeTask(pi, ti)}>×</button>}
              </div>
            ))}
            <button className="plan-form-btn-sm" onClick={() => addTask(pi)}>+ Add Task</button>
          </div>
        </div>
      ))}
      <button className="plan-form-btn-sm" onClick={addPhase}>+ Add Phase</button>

      <div className="plan-form-actions">
        <button className="plan-form-btn plan-form-btn-primary" onClick={handleSubmit} disabled={saving}>
          {saving ? 'Creating...' : 'Create Plan'}
        </button>
        <button className="plan-form-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function PlanningBoard({ plans, onPlanCreated }: PlanningBoardProps) {
  const [showForm, setShowForm] = useState(false);
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

  return (
    <div className="collab-board-wrapper">
      <div className="collab-board-toolbar">
        <button
          className={`plan-form-btn ${showForm ? '' : 'plan-form-btn-primary'}`}
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? 'Cancel' : '+ New Plan'}
        </button>
      </div>

      {showForm && (
        <PlanForm
          onSubmit={() => { setShowForm(false); onPlanCreated?.(); }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {plans.length === 0 && !showForm ? (
        <div className="collab-empty" style={{ padding: '40px 20px' }}>No plans yet. Click "New Plan" to create one.</div>
      ) : (
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
      )}
    </div>
  );
}
