import React, { useEffect, useState } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import { authedFetch, getWorkerToken, setWorkerToken } from '../utils/auth';

/**
 * Blocks the app until the worker answers an authenticated probe.
 *
 * /api/settings is the cheapest authenticated GET the viewer already needs.
 * 401 ⇒ the worker wants the owner token: show the paste-the-token form.
 * Any other answer (200, worker down, network error) ⇒ let the app mount and
 * surface its own error UI — when CLAUDE_MEM_WORKER_AUTH=off there is no
 * token at all, and gating on its presence would lock those installs out.
 */
export function WorkerAuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'needed' | 'ok'>('checking');
  const [tokenInput, setTokenInput] = useState('');
  const [rejected, setRejected] = useState(false);

  const probe = () => {
    setState('checking');
    authedFetch(API_ENDPOINTS.SETTINGS)
      .then(res => {
        if (res.status === 401) {
          // A stored token that still gets 401 was wrong — say so.
          setRejected(getWorkerToken() !== '');
          setState('needed');
        } else {
          setState('ok');
        }
      })
      .catch(() => setState('ok'));
  };

  useEffect(probe, []);

  if (state === 'ok') return <>{children}</>;

  if (state === 'needed') {
    const submit = (event: React.FormEvent) => {
      event.preventDefault();
      const token = tokenInput.trim();
      if (!token) return;
      setWorkerToken(token);
      probe();
    };
    return (
      <div style={{ maxWidth: 480, margin: '15vh auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <h2 style={{ marginTop: 0 }}>Worker token required</h2>
        <p>
          This claude-mem worker requires its owner token for API access. Paste the token from{' '}
          <code>~/.claude-mem/worker-auth-token</code>:
        </p>
        <pre style={{ background: '#f5f5f5', padding: 8 }}>cat ~/.claude-mem/worker-auth-token</pre>
        <form onSubmit={submit}>
          <input
            type="password"
            value={tokenInput}
            onChange={e => setTokenInput(e.target.value)}
            placeholder="worker auth token"
            autoFocus
            style={{ width: '100%', padding: 8, boxSizing: 'border-box' }}
          />
          <button type="submit" style={{ marginTop: 12, padding: '8px 16px' }}>
            Unlock
          </button>
        </form>
        {rejected && <p style={{ color: '#b00020' }}>That token was not accepted — check the file and try again.</p>}
        <p style={{ color: '#666', fontSize: 13 }}>
          Single-user machine? <code>CLAUDE_MEM_WORKER_AUTH=off</code> disables this check
          (file/env setting, worker restart required).
        </p>
      </div>
    );
  }

  // checking — keep the flash short; the probe is localhost-fast.
  return null;
}
