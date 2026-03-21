import React, { useState, useRef, useCallback, useEffect } from 'react';
import { API_ENDPOINTS } from '../constants/api';

interface PromptBarProps {
  projects: string[];
  agents: string[];
  onPromptSent?: (taskId: number, agent: string) => void;
}

interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export function PromptBar({ projects, agents, onPromptSent }: PromptBarProps) {
  const [prompt, setPrompt] = useState('');
  const [selectedAgent, setSelectedAgent] = useState('auto');
  const [selectedProject, setSelectedProject] = useState('');
  const [customCwd, setCustomCwd] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [lastResult, setLastResult] = useState<{ taskId: number; agent: string } | null>(null);
  const [showBrowser, setShowBrowser] = useState(false);
  const [browserPath, setBrowserPath] = useState('C:\\Projects');
  const [browserEntries, setBrowserEntries] = useState<BrowseEntry[]>([]);
  const [browserLoading, setBrowserLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const availableAgents = agents.length > 0 ? agents : ['claude-code', 'codex', 'claude-app'];

  const browseDirectory = useCallback(async (path: string) => {
    setBrowserLoading(true);
    try {
      const res = await fetch(API_ENDPOINTS.BROWSE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      });
      if (res.ok) {
        const data = await res.json();
        setBrowserPath(data.path);
        setBrowserEntries(data.entries || []);
      }
    } catch (err) {
      console.error('Browse failed:', err);
    }
    setBrowserLoading(false);
  }, []);

  const handleBrowseOpen = useCallback(() => {
    setShowBrowser(true);
    browseDirectory(browserPath);
  }, [browserPath, browseDirectory]);

  const handleSelectDir = useCallback((entry: BrowseEntry) => {
    if (entry.isDirectory) {
      setCustomCwd(entry.path);
      setSelectedProject(entry.name);
      setShowBrowser(false);
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim() || isSending) return;
    setIsSending(true);
    setLastResult(null);
    try {
      const res = await fetch(API_ENDPOINTS.PROMPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          agent: selectedAgent,
          project: selectedProject || undefined,
          cwd: customCwd || undefined
        })
      });
      if (res.ok) {
        const data = await res.json();
        setLastResult({ taskId: data.task_id, agent: data.dispatched_to });
        setPrompt('');
        onPromptSent?.(data.task_id, data.dispatched_to);
      }
    } catch (err) {
      console.error('Prompt send failed:', err);
    }
    setIsSending(false);
  }, [prompt, selectedAgent, selectedProject, customCwd, isSending, onPromptSent]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [prompt]);

  return (
    <>
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: 'var(--bg-primary, #1a1a2e)',
        borderTop: '1px solid var(--border-color, #333)',
        padding: '12px 20px', zIndex: 1000,
        display: 'flex', flexDirection: 'column', gap: '8px'
      }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={selectedAgent} onChange={(e) => setSelectedAgent(e.target.value)}
            style={{ background: 'var(--bg-secondary, #16213e)', color: 'var(--text-primary, #e0e0e0)',
              border: '1px solid var(--border-color, #444)', borderRadius: '6px', padding: '4px 8px', fontSize: '12px', cursor: 'pointer' }}>
            <option value="auto">Auto (Leader)</option>
            {availableAgents.map(a => <option key={a} value={a}>{a}</option>)}
          </select>

          <select value={selectedProject}
            onChange={(e) => {
              setSelectedProject(e.target.value);
              if (e.target.value === '__browse__') { handleBrowseOpen(); setSelectedProject(''); }
            }}
            style={{ background: 'var(--bg-secondary, #16213e)', color: 'var(--text-primary, #e0e0e0)',
              border: '1px solid var(--border-color, #444)', borderRadius: '6px', padding: '4px 8px', fontSize: '12px', cursor: 'pointer', maxWidth: '200px' }}>
            <option value="">No project</option>
            {projects.map(p => <option key={p} value={p}>{p}</option>)}
            <option value="__browse__">Browse C: drive...</option>
          </select>

          {customCwd && (
            <span style={{ fontSize: '11px', color: 'var(--text-secondary, #888)', background: 'var(--bg-tertiary, #1e1e3a)',
              padding: '2px 8px', borderRadius: '4px', maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {customCwd}
            </span>
          )}

          {lastResult && (
            <span style={{ fontSize: '11px', color: '#4ade80', marginLeft: 'auto' }}>
              Dispatched to {lastResult.agent} (task #{lastResult.taskId})
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
          <textarea ref={textareaRef} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Type a prompt for the AI agents... (Ctrl+Enter to send)" rows={1}
            style={{ flex: 1, background: 'var(--bg-secondary, #16213e)', color: 'var(--text-primary, #e0e0e0)',
              border: '1px solid var(--border-color, #444)', borderRadius: '8px', padding: '10px 14px', fontSize: '14px',
              resize: 'none', fontFamily: 'inherit', lineHeight: '1.4', outline: 'none', minHeight: '40px', maxHeight: '120px' }} />
          <button onClick={handleSubmit} disabled={!prompt.trim() || isSending}
            style={{ background: prompt.trim() && !isSending ? 'var(--accent-color, #7c3aed)' : 'var(--bg-tertiary, #333)',
              color: '#fff', border: 'none', borderRadius: '8px', padding: '10px 20px', fontSize: '14px',
              cursor: prompt.trim() && !isSending ? 'pointer' : 'not-allowed', fontWeight: 600, whiteSpace: 'nowrap',
              opacity: prompt.trim() && !isSending ? 1 : 0.5, transition: 'all 0.15s ease' }}>
            {isSending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>

      {showBrowser && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)',
          zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setShowBrowser(false)}>
          <div style={{ background: 'var(--bg-primary, #1a1a2e)', border: '1px solid var(--border-color, #444)',
            borderRadius: '12px', padding: '20px', width: '500px', maxHeight: '60vh', display: 'flex', flexDirection: 'column' }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px 0', color: 'var(--text-primary, #e0e0e0)' }}>Browse Project Directory</h3>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', alignItems: 'center' }}>
              <button onClick={() => { const parent = browserPath.split(/[/\\]/).slice(0, -1).join('\\') || 'C:\\'; browseDirectory(parent); }}
                style={{ background: 'var(--bg-secondary, #16213e)', color: 'var(--text-primary, #e0e0e0)',
                  border: '1px solid var(--border-color, #444)', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', fontSize: '13px' }}>
                Up
              </button>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary, #999)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {browserPath}
              </span>
            </div>
            <div style={{ overflowY: 'auto', flex: 1, border: '1px solid var(--border-color, #333)', borderRadius: '6px' }}>
              {browserLoading ? (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary, #888)' }}>Loading...</div>
              ) : browserEntries.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary, #888)' }}>No subdirectories</div>
              ) : browserEntries.map(entry => (
                <div key={entry.path} style={{ padding: '8px 14px', borderBottom: '1px solid var(--border-color, #222)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', transition: 'background 0.1s' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-secondary, #16213e)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                  <span style={{ color: 'var(--text-primary, #e0e0e0)', fontSize: '13px', flex: 1 }}
                    onClick={() => browseDirectory(entry.path)}>{entry.name}/</span>
                  <button onClick={() => handleSelectDir(entry)}
                    style={{ background: 'var(--accent-color, #7c3aed)', color: '#fff', border: 'none',
                      borderRadius: '4px', padding: '3px 10px', fontSize: '11px', cursor: 'pointer' }}>Select</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
