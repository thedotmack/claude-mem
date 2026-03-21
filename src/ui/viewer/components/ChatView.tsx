import React, { useState, useRef, useEffect, useCallback } from 'react';
import { API_ENDPOINTS } from '../constants/api';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
  model?: string;
}

interface ChatViewProps {
  controls: {
    leader: string;
    agents: Record<string, any>;
  } | null;
}

// Persist chat per agent in localStorage
function loadChat(agent: string): ChatMessage[] {
  try { return JSON.parse(localStorage.getItem(`chat_${agent}`) || '[]'); } catch { return []; }
}
function saveChat(agent: string, msgs: ChatMessage[]) {
  try { localStorage.setItem(`chat_${agent}`, JSON.stringify(msgs.slice(-100))); } catch {}
}

export function ChatView({ controls }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const agents = controls ? Object.keys(controls.agents) : [];

  // Auto-select first custom agent or first agent
  useEffect(() => {
    if (!selectedAgent && agents.length > 0) {
      const custom = agents.find(a => !['claude-code', 'codex', 'claude-app'].includes(a));
      const agent = custom || agents[0];
      setSelectedAgent(agent);
      setMessages(loadChat(agent));
    }
  }, [agents, selectedAgent]);

  // Load chat when agent changes
  useEffect(() => {
    if (selectedAgent) setMessages(loadChat(selectedAgent));
  }, [selectedAgent]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const getModel = useCallback(() => {
    if (!controls || !selectedAgent) return 'unknown';
    return controls.agents[selectedAgent]?.model || 'nvidia/nemotron-3-super-120b-a12b:free';
  }, [controls, selectedAgent]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || isStreaming || !selectedAgent) return;

    const userMsg: ChatMessage = { role: 'user', content: input.trim(), timestamp: Date.now() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    saveChat(selectedAgent, newMessages);
    setInput('');
    setIsStreaming(true);
    setStreamingContent('');
    setError(null);

    try {
      abortRef.current = new AbortController();

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsg.content,
          agent: selectedAgent,
          history: messages.slice(-20) // Last 20 messages for context
        }),
        signal: abortRef.current.signal
      });

      if (!res.ok) {
        const errData = await res.json();
        setError(errData.error || `Error ${res.status}`);
        setIsStreaming(false);
        return;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.content) {
                  fullContent += parsed.content;
                  setStreamingContent(fullContent);
                }
                if (parsed.error) {
                  setError(parsed.error);
                }
              } catch {}
            }
          }
        }
      }

      if (fullContent) {
        const assistantMsg: ChatMessage = { role: 'assistant', content: fullContent, timestamp: Date.now(), model: getModel() };
        setMessages(prev => {
          const updated = [...prev, assistantMsg];
          saveChat(selectedAgent, updated);
          return updated;
        });
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(err.message);
      }
    }

    setStreamingContent('');
    setIsStreaming(false);
    abortRef.current = null;
  }, [input, isStreaming, selectedAgent, messages, getModel]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }, [sendMessage]);

  const clearChat = useCallback(() => {
    setMessages([]);
    setStreamingContent('');
    setError(null);
    if (selectedAgent) saveChat(selectedAgent, []);
  }, [selectedAgent]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 200px)', maxWidth: '960px', margin: '0 auto', padding: '0 20px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 0', borderBottom: '1px solid var(--color-border-primary, #333)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h3 style={{ margin: 0, color: 'var(--color-text-primary, #e0e0e0)', fontSize: '16px' }}>Chat</h3>
          <select value={selectedAgent} onChange={(e) => { setSelectedAgent(e.target.value); clearChat(); }}
            style={{ background: 'var(--color-bg-card, #16213e)', color: 'var(--color-text-primary, #e0e0e0)',
              border: '1px solid var(--color-border-primary, #444)', borderRadius: '6px', padding: '5px 10px', fontSize: '13px' }}>
            {agents.map(a => {
              const model = controls?.agents[a]?.model || 'unknown';
              return <option key={a} value={a}>{a} ({model})</option>;
            })}
          </select>
          <span style={{ fontSize: '11px', color: 'var(--color-text-secondary, #888)', fontFamily: 'monospace' }}>
            {getModel()}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {isStreaming && (
            <button onClick={stopStreaming} style={{ background: '#f87171', color: '#fff', border: 'none',
              borderRadius: '6px', padding: '5px 12px', fontSize: '12px', cursor: 'pointer' }}>Stop</button>
          )}
          <button onClick={clearChat} style={{ background: 'var(--color-bg-card, #16213e)',
            color: 'var(--color-text-secondary, #888)', border: '1px solid var(--color-border-primary, #444)',
            borderRadius: '6px', padding: '5px 12px', fontSize: '12px', cursor: 'pointer' }}>Clear</button>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0' }}>
        {messages.length === 0 && !streamingContent && (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--color-text-secondary, #888)' }}>
            <div style={{ fontSize: '24px', marginBottom: '12px' }}>Start a conversation</div>
            <div style={{ fontSize: '13px' }}>
              Select an agent above and type a message. The agent's configured model ({getModel()}) will respond via OpenRouter.
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{
            display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            marginBottom: '12px'
          }}>
            <div style={{
              maxWidth: '80%', padding: '12px 16px', borderRadius: '12px',
              background: msg.role === 'user' ? 'var(--color-accent-primary, #7c3aed)' : 'var(--color-bg-card, #1e1e3a)',
              color: msg.role === 'user' ? '#fff' : 'var(--color-text-primary, #e0e0e0)',
              border: msg.role === 'assistant' ? '1px solid var(--color-border-primary, #333)' : 'none',
            }}>
              {msg.role === 'assistant' && msg.model && (
                <div style={{ fontSize: '10px', color: 'var(--color-text-secondary, #888)', marginBottom: '6px', fontFamily: 'monospace' }}>
                  {msg.model}
                </div>
              )}
              <div style={{ fontSize: '14px', lineHeight: '1.6', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {msg.content}
              </div>
              {msg.timestamp && (
                <div style={{ fontSize: '10px', color: msg.role === 'user' ? 'rgba(255,255,255,0.6)' : 'var(--color-text-secondary, #666)',
                  marginTop: '6px', textAlign: 'right' }}>
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Streaming response */}
        {streamingContent && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '12px' }}>
            <div style={{
              maxWidth: '80%', padding: '12px 16px', borderRadius: '12px',
              background: 'var(--color-bg-card, #1e1e3a)',
              border: '1px solid var(--color-accent-primary, #7c3aed)',
              color: 'var(--color-text-primary, #e0e0e0)',
            }}>
              <div style={{ fontSize: '10px', color: '#7c3aed', marginBottom: '6px', fontFamily: 'monospace' }}>
                {getModel()} (streaming...)
              </div>
              <div style={{ fontSize: '14px', lineHeight: '1.6', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {streamingContent}
                <span style={{ animation: 'blink 1s infinite' }}>|</span>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div style={{ padding: '12px 16px', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
            borderRadius: '8px', color: '#f87171', fontSize: '13px', marginBottom: '12px' }}>
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{ padding: '12px 0', borderTop: '1px solid var(--color-border-primary, #333)',
        display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
        <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
          placeholder={`Message ${selectedAgent} (${getModel()})... (Enter to send, Shift+Enter for newline)`}
          rows={1} disabled={isStreaming}
          style={{
            flex: 1, background: 'var(--color-bg-card, #16213e)', color: 'var(--color-text-primary, #e0e0e0)',
            border: '1px solid var(--color-border-primary, #444)', borderRadius: '10px', padding: '12px 16px',
            fontSize: '14px', resize: 'none', fontFamily: 'inherit', lineHeight: '1.4', outline: 'none',
            minHeight: '44px', maxHeight: '120px', opacity: isStreaming ? 0.5 : 1,
          }}
          onInput={(e) => {
            const t = e.target as HTMLTextAreaElement;
            t.style.height = 'auto';
            t.style.height = Math.min(t.scrollHeight, 120) + 'px';
          }}
        />
        <button onClick={sendMessage} disabled={!input.trim() || isStreaming}
          style={{
            background: input.trim() && !isStreaming ? 'var(--color-accent-primary, #7c3aed)' : 'var(--color-bg-card, #333)',
            color: '#fff', border: 'none', borderRadius: '10px', padding: '12px 24px', fontSize: '14px',
            cursor: input.trim() && !isStreaming ? 'pointer' : 'not-allowed', fontWeight: 600,
            opacity: input.trim() && !isStreaming ? 1 : 0.5, transition: 'all 0.15s ease',
          }}>
          Send
        </button>
      </div>

      <style>{`@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>
    </div>
  );
}
