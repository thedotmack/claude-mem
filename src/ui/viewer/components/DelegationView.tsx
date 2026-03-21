import React, { useState, useCallback, useEffect } from 'react';
import { API_ENDPOINTS } from '../constants/api';

interface Task {
  id: number;
  title: string;
  narrative?: string;
  type: string;
  project?: string;
  author?: string;
  metadata?: { assignee?: string; task_status?: string; delegated_by?: string };
  created_at_epoch: number;
}

interface DelegationViewProps {
  controls: { leader: string; agents: Record<string, any> } | null;
  pendingTasks: Task[];
  onRefresh: () => void;
}

export function DelegationView({ controls, pendingTasks, onRefresh }: DelegationViewProps) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [targetAgent, setTargetAgent] = useState('');
  const [project, setProject] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);

  const agents = controls ? Object.keys(controls.agents) : ['claude-code', 'codex', 'claude-app'];

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch(`${API_ENDPOINTS.OBSERVATIONS}?type=task&limit=50`);
      if (res.ok) { const data = await res.json(); setTasks(data.observations || []); }
    } catch (e) { console.error('Failed to fetch tasks:', e); }
  }, []);

  useEffect(() => { fetchTasks(); const i = setInterval(fetchTasks, 10000); return () => clearInterval(i); }, [fetchTasks]);

  const handleDelegate = useCallback(async () => {
    if (!title.trim() || !targetAgent) return;
    setIsSending(true);
    try {
      const res = await fetch(API_ENDPOINTS.DELEGATE, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: controls?.leader || 'user', to: targetAgent, title: title.trim(),
          description: description.trim(), project: project || undefined, urgent })
      });
      if (res.ok) { setTitle(''); setDescription(''); setTargetAgent(''); setProject(''); setUrgent(false); setShowForm(false); fetchTasks(); onRefresh(); }
    } catch (e) { console.error('Delegation failed:', e); }
    setIsSending(false);
  }, [title, description, targetAgent, project, urgent, controls, fetchTasks, onRefresh]);

  const updateTaskStatus = useCallback(async (taskId: number, status: string) => {
    try { await fetch(`${API_ENDPOINTS.TASKS}/${taskId}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); fetchTasks(); }
    catch (e) { console.error('Failed to update task:', e); }
  }, [fetchTasks]);

  const tasksByAgent: Record<string, Task[]> = {};
  const allTasks = [...tasks, ...pendingTasks].reduce((acc, t) => { if (!acc.has(t.id)) acc.set(t.id, t); return acc; }, new Map<number, Task>());
  Array.from(allTasks.values()).forEach(t => { const a = t.metadata?.assignee || 'unassigned'; if (!tasksByAgent[a]) tasksByAgent[a] = []; tasksByAgent[a].push(t); });

  const statusColors: Record<string, string> = { pending: '#facc15', in_progress: '#60a5fa', completed: '#4ade80', failed: '#f87171' };

  return (
    <div style={{ marginBottom: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ margin: 0, color: 'var(--text-primary, #e0e0e0)', fontSize: '16px' }}>Task Delegation ({Array.from(allTasks.values()).length} tasks)</h3>
        <button onClick={() => setShowForm(!showForm)} style={{ background: 'var(--accent-color, #7c3aed)', color: '#fff', border: 'none', borderRadius: '6px', padding: '5px 14px', fontSize: '12px', cursor: 'pointer' }}>+ Delegate Task</button>
      </div>

      {showForm && (
        <div style={{ padding: '16px', background: 'var(--bg-secondary, #16213e)', borderRadius: '10px', border: '1px solid var(--border-color, #333)', marginBottom: '16px' }}>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title"
              style={{ flex: 1, background: 'var(--bg-primary, #1a1a2e)', color: 'var(--text-primary, #e0e0e0)', border: '1px solid var(--border-color, #444)', borderRadius: '6px', padding: '8px 12px', fontSize: '13px' }} />
            <select value={targetAgent} onChange={(e) => setTargetAgent(e.target.value)}
              style={{ background: 'var(--bg-primary, #1a1a2e)', color: 'var(--text-primary, #e0e0e0)', border: '1px solid var(--border-color, #444)', borderRadius: '6px', padding: '8px 12px', fontSize: '13px' }}>
              <option value="">Assign to...</option>
              {agents.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Task description (optional)" rows={3}
            style={{ width: '100%', background: 'var(--bg-primary, #1a1a2e)', color: 'var(--text-primary, #e0e0e0)', border: '1px solid var(--border-color, #444)', borderRadius: '6px', padding: '8px 12px', fontSize: '13px', resize: 'vertical', fontFamily: 'inherit', marginBottom: '10px', boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input type="text" value={project} onChange={(e) => setProject(e.target.value)} placeholder="Project (optional)"
              style={{ flex: 1, background: 'var(--bg-primary, #1a1a2e)', color: 'var(--text-primary, #e0e0e0)', border: '1px solid var(--border-color, #444)', borderRadius: '6px', padding: '6px 10px', fontSize: '12px' }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--text-secondary, #888)', cursor: 'pointer' }}>
              <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> Urgent
            </label>
            <button onClick={handleDelegate} disabled={!title.trim() || !targetAgent || isSending}
              style={{ background: title.trim() && targetAgent && !isSending ? '#4ade80' : 'var(--bg-tertiary, #333)', color: '#000', border: 'none', borderRadius: '6px', padding: '6px 18px', fontSize: '13px', fontWeight: 600, cursor: title.trim() && targetAgent && !isSending ? 'pointer' : 'not-allowed', opacity: title.trim() && targetAgent && !isSending ? 1 : 0.5 }}>
              {isSending ? 'Sending...' : 'Delegate'}
            </button>
            <button onClick={() => setShowForm(false)} style={{ background: 'transparent', color: 'var(--text-secondary, #888)', border: '1px solid var(--border-color, #444)', borderRadius: '6px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}

      {Object.keys(tasksByAgent).length === 0 ? (
        <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-secondary, #888)', background: 'var(--bg-secondary, #16213e)', borderRadius: '10px', border: '1px solid var(--border-color, #333)' }}>
          No tasks delegated yet. Click "Delegate Task" or use the prompt bar to assign work.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '16px' }}>
          {Object.entries(tasksByAgent).map(([agent, agentTasks]) => (
            <div key={agent} style={{ background: 'var(--bg-secondary, #16213e)', border: '1px solid var(--border-color, #333)', borderRadius: '10px', padding: '14px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary, #e0e0e0)', marginBottom: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{agent}</span>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary, #888)', fontWeight: 400 }}>{agentTasks.length} task{agentTasks.length !== 1 ? 's' : ''}</span>
              </div>
              {agentTasks.map(task => {
                const status = task.metadata?.task_status || 'pending';
                return (
                  <div key={task.id} style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-color, #222)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '13px', color: 'var(--text-primary, #e0e0e0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
                      {task.metadata?.delegated_by && <div style={{ fontSize: '11px', color: 'var(--text-secondary, #666)', marginTop: '2px' }}>from {task.metadata.delegated_by}</div>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                      <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', background: `${statusColors[status] || '#888'}22`, color: statusColors[status] || '#888', fontWeight: 600, textTransform: 'uppercase' }}>{status.replace('_', ' ')}</span>
                      {status === 'pending' && (
                        <button onClick={() => updateTaskStatus(task.id, 'completed')} title="Mark completed"
                          style={{ background: 'transparent', border: '1px solid var(--border-color, #444)', borderRadius: '4px', color: '#4ade80', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}>Done</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
