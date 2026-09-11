import React, { useState, useEffect, useMemo } from 'react';
import type { GeminiRateLimitsStatus, ModelUsageState } from '../types';

interface GeminiStatusModalProps {
  isOpen: boolean;
  onClose: () => void;
  geminiStatus: GeminiRateLimitsStatus | null;
  onRefresh: () => Promise<void>;
}

function calculateUtcResetCountdown(): string {
  const now = new Date();
  const nextReset = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  const diffMs = Math.max(0, nextReset.getTime() - now.getTime());
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
}

export function GeminiStatusModal({
  isOpen,
  onClose,
  geminiStatus,
  onRefresh,
}: GeminiStatusModalProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'pro' | 'flash' | 'gemma' | 'omni' | 'lite'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [countdownSeconds, setCountdownSeconds] = useState<number>(0);
  const [utcResetTime, setUtcResetTime] = useState<string>(calculateUtcResetCountdown());
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibratedValue, setCalibratedValue] = useState<string>('');
  const [isSubmittingCalibration, setIsSubmittingCalibration] = useState(false);
  const [isSubmittingTier, setIsSubmittingTier] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setUtcResetTime(calculateUtcResetCountdown());
    }, 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (geminiStatus?.queue.isWaitingForQuota && geminiStatus.queue.quotaWaitRemainingMs > 0) {
      setCountdownSeconds(Math.ceil(geminiStatus.queue.quotaWaitRemainingMs / 1000));
    }
  }, [geminiStatus?.queue.quotaWaitRemainingMs, geminiStatus?.queue.isWaitingForQuota]);

  useEffect(() => {
    if (countdownSeconds <= 0) return;
    const timer = setInterval(() => {
      setCountdownSeconds(prev => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [countdownSeconds]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }
  }, [isOpen, onClose]);

  const cascade = useMemo(() => geminiStatus?.cascade || [], [geminiStatus?.cascade]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: cascade.length, pro: 0, flash: 0, gemma: 0, omni: 0, lite: 0 };
    for (const m of cascade) {
      if (counts[m.category] !== undefined) {
        counts[m.category]++;
      }
    }
    return counts;
  }, [cascade]);

  const filteredCascade = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return cascade.filter(m => {
      const matchesCategory = selectedFilter === 'all' || m.category === selectedFilter;
      if (!matchesCategory) return false;
      if (!term) return true;
      return (
        m.id.toLowerCase().includes(term) ||
        m.displayName.toLowerCase().includes(term) ||
        m.category.toLowerCase().includes(term) ||
        (m.description && m.description.toLowerCase().includes(term))
      );
    });
  }, [cascade, selectedFilter, searchTerm]);

  if (!isOpen) return null;

  const handleRefreshClick = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleModelSelect = async (modelId: string) => {
    try {
      await fetch('/api/gemini/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
      });
      await onRefresh();
    } catch (e) {
      console.error('Failed to select model', e);
    }
  };

  const handleToggleAutoFallback = async () => {
    if (!geminiStatus) return;
    try {
      await fetch('/api/gemini/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoFallback: !geminiStatus.autoFallback }),
      });
      await onRefresh();
    } catch (e) {
      console.error('Failed to toggle auto fallback', e);
    }
  };

  const handleCalibrateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const count = parseInt(calibratedValue, 10);
    if (isNaN(count) || count < 0) return;
    setIsSubmittingCalibration(true);
    try {
      await fetch('/api/gemini/calibrate-rpd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: activeModel, count }),
      });
      setIsCalibrating(false);
      setCalibratedValue('');
      await onRefresh();
    } catch (err) {
      console.error('Failed to calibrate RPD', err);
    } finally {
      setIsSubmittingCalibration(false);
    }
  };

  const handleTierSelect = async (tier: 'free' | 'payg') => {
    setIsSubmittingTier(true);
    try {
      await fetch('/api/gemini/tier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      await onRefresh();
    } catch (err) {
      console.error('Failed to set plan tier', err);
    } finally {
      setIsSubmittingTier(false);
    }
  };

  const formatTokens = (tokens: number): string => {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
    return String(tokens);
  };

  const getStatusBadge = (state?: ModelUsageState) => {
    if (!state) return <span className="status-pill status-ready">● Pronto</span>;
    const title = state.cooldownReason || undefined;
    switch (state.status) {
      case 'active':
        return <span className="status-pill status-active" title={title}>⚡ Ativo</span>;
      case 'cooldown':
        return <span className="status-pill status-cooldown" title={title}>⏳ Cooldown</span>;
      case 'exhausted':
        return <span className="status-pill status-exhausted" title={title}>🚫 Cota Esgotada</span>;
      case 'unsupported':
        return <span className="status-pill status-unsupported" title={title}>⚠️ Indisponível</span>;
      default:
        return <span className="status-pill status-ready" title={title}>● Pronto</span>;
    }
  };

  const getUsageLevel = (percent: number) => {
    if (percent >= 85) return 'usage-critical';
    if (percent >= 60) return 'usage-warning';
    return 'usage-normal';
  };

  const activeModel = geminiStatus?.activeModel || 'gemini-3.7-flash';
  const activeModelState = geminiStatus?.models[activeModel];
  const activeModelInfo = cascade.find(m => m.id === activeModel);

  const rpmLimit = activeModelState?.rpmLimit || activeModelInfo?.rpmLimit || 15;
  const rpmUsed = activeModelState?.rpmUsed || 0;
  const rpmPercent = rpmLimit > 0 ? Math.min(100, Math.round((rpmUsed / rpmLimit) * 100)) : 0;

  const tpmLimit = activeModelState?.tpmLimit || activeModelInfo?.tpmLimit || 1000000;
  const tpmUsed = activeModelState?.tpmUsed || 0;
  const tpmPercent = tpmLimit > 0 ? Math.min(100, Math.round((tpmUsed / tpmLimit) * 100)) : 0;

  const rpdLimit = activeModelState?.rpdLimit || activeModelInfo?.rpdLimit || 1500;
  const rpdUsed = activeModelState?.rpdUsed || 0;
  const rpdPercent = rpdLimit > 0 ? Math.min(100, Math.round((rpdUsed / rpdLimit) * 100)) : 0;
  const rpdRemaining = Math.max(0, rpdLimit - rpdUsed);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="gemini-modal-container" onClick={e => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="gemini-modal-header">
          <div className="gemini-header-titles">
            <div className="gemini-header-main-title">
              <span className="gemini-sparkle-icon">⚡</span>
              <h2>Gemini Dynamic Engine & Rate Limiter</h2>
            </div>
            <p className="gemini-header-sub">
              Monitoramento dinâmico em tempo real de limites (RPD, RPM, TPM), fila resiliente e cascata adaptativa
            </p>
          </div>
          <div className="gemini-header-actions">
            <button
              type="button"
              className="gemini-refresh-btn"
              onClick={handleRefreshClick}
              disabled={isRefreshing}
              title="Redescobrir modelos ativos consultando Google AI Studio"
            >
              <span className={`refresh-icon ${isRefreshing ? 'spinning' : ''}`}>🔄</span>
              <span className="refresh-label">{isRefreshing ? 'Redescobrindo...' : 'Redescobrir Modelos'}</span>
            </button>
            <button
              type="button"
              className="gemini-close-btn"
              onClick={onClose}
              title="Fechar (Esc)"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Modal Body with dedicated flex column layout */}
        <div className="gemini-modal-body">
          {/* Master Hero Card: Active Model Identity & Prominent RPD Progress Bar */}
          <div className="gemini-hero-card">
            <div className="gemini-hero-top">
              {/* Left Column: Active Model Identity */}
              <div className="gemini-hero-identity">
                <div className="hero-identity-badges">
                  <span className="hero-rank-badge">#{activeModelInfo?.rank ?? 1}</span>
                  {activeModelInfo && (
                    <span className={`cat-pill cat-${activeModelInfo.category}`}>
                      {activeModelInfo.category.toUpperCase()}
                    </span>
                  )}
                  {activeModelInfo?.isPerpetualAlias && (
                    <span className="badge-perpetual">perpétuo</span>
                  )}
                  {activeModelInfo?.isPreview && (
                    <span className="badge-preview">preview</span>
                  )}
                </div>

                <div className="hero-model-title-wrap">
                  <span className="hero-active-glow-dot" />
                  <h3 className="hero-model-name" title={activeModel}>
                    {activeModel}
                  </h3>
                </div>

                <div className="hero-model-meta">
                  <span className="hero-meta-item">
                    Contexto: <strong>{formatTokens(activeModelInfo?.contextWindow ?? 1048576)} tokens</strong>
                  </span>
                  <span className="hero-meta-item">
                    Saída: <strong>{formatTokens(activeModelInfo?.outputLimit ?? 8192)}</strong>
                  </span>
                </div>

                <div className="hero-toggle-wrap">
                  <button
                    type="button"
                    className={`gemini-switch-btn ${geminiStatus?.autoFallback ? 'is-active' : 'is-disabled'}`}
                    onClick={handleToggleAutoFallback}
                    title="Alternar entre Cascata Inteligente e Modelo Fixo"
                  >
                    <span className="switch-knob" />
                    <span className="switch-text">
                      {geminiStatus?.autoFallback ? '✨ Cascata Automática Ativa' : '⏸️ Modelo Fixo'}
                    </span>
                  </button>
                  <span className="hero-toggle-hint">
                    {geminiStatus?.autoFallback
                      ? 'Comuta proativamente ao esgotar quota'
                      : 'Fixado no modelo selecionado'}
                  </span>
                </div>
              </div>

              {/* Right Column: Prominent RPD Progress Showcase */}
              <div className="gemini-hero-rpd">
                <div className="rpd-showcase-header">
                  <div className="rpd-header-title-row">
                    <span className="rpd-badge-title">COTA DIÁRIA (RPD)</span>
                    <div className="rpd-tier-toggle">
                      <button
                        type="button"
                        className={`tier-pill ${(!geminiStatus?.tier || geminiStatus.tier === 'free') ? 'active' : ''}`}
                        onClick={() => handleTierSelect('free')}
                        disabled={isSubmittingTier}
                        title="Google AI Studio Free Tier (gratuito: Flash-Lite 500 RPD, Pro 50 RPD)"
                      >
                        Free Tier
                      </button>
                      <button
                        type="button"
                        className={`tier-pill ${geminiStatus?.tier === 'payg' ? 'active' : ''}`}
                        onClick={() => handleTierSelect('payg')}
                        disabled={isSubmittingTier}
                        title="Google AI Studio Pay-As-You-Go (pago: Flash-Lite 4,000 RPD, Pro 1,000 RPD)"
                      >
                        Pay-As-You-Go
                      </button>
                    </div>
                    <span className={`rpd-status-chip ${getUsageLevel(rpdPercent)}`}>
                      {rpdPercent >= 85 ? '⚠️ Crítico' : rpdPercent >= 60 ? '⚡ Atenção' : '● Saudável'} • {rpdPercent}% Usado
                    </span>
                  </div>
                  <div className="rpd-reset-timer" title="A cota diária do Google AI Studio é renovada às 00:00 UTC">
                    <span className="reset-icon">⏱️</span>
                    <span>Reseta em <strong>{utcResetTime}</strong> (00:00 UTC)</span>
                  </div>
                </div>

                {/* Master RPD Progress Bar */}
                <div className="gemini-master-rpd-track" title={`${rpdPercent}% da cota diária utilizada`}>
                  <div
                    className={`gemini-master-rpd-fill ${getUsageLevel(rpdPercent)}`}
                    style={{ width: `${Math.max(2, rpdPercent)}%` }}
                  />
                </div>

                {/* RPD Numeric Breakdown */}
                <div className="rpd-showcase-stats">
                  <div className="rpd-stat-main">
                    <span className="rpd-used-count">{rpdUsed}</span>
                    <span className="rpd-sep">/</span>
                    <span className="rpd-limit-count">{rpdLimit}</span>
                    <span className="rpd-unit">requisições hoje</span>
                    {!isCalibrating && (
                      <button
                        type="button"
                        className="rpd-calibrate-btn"
                        onClick={() => {
                          setCalibratedValue(String(rpdUsed));
                          setIsCalibrating(true);
                        }}
                        title="Ajustar contagem para sincronizar com o painel do Google AI Studio"
                      >
                        ✎ Calibrar
                      </button>
                    )}
                  </div>
                  <div className="rpd-stat-remaining">
                    <span className="rpd-remaining-val">{rpdRemaining}</span>
                    <span className="rpd-remaining-label">restantes</span>
                  </div>
                </div>

                {isCalibrating && (
                  <form className="rpd-calibrate-form" onSubmit={handleCalibrateSubmit}>
                    <span className="calibrate-label">AI Studio:</span>
                    <input
                      type="number"
                      min="0"
                      max="100000"
                      value={calibratedValue}
                      onChange={e => setCalibratedValue(e.target.value)}
                      className="calibrate-input"
                      placeholder="Ex: 340"
                      autoFocus
                    />
                    <button
                      type="submit"
                      className="calibrate-confirm-btn"
                      disabled={isSubmittingCalibration}
                    >
                      {isSubmittingCalibration ? '...' : 'Salvar'}
                    </button>
                    <button
                      type="button"
                      className="calibrate-cancel-btn"
                      onClick={() => setIsCalibrating(false)}
                    >
                      ✕
                    </button>
                  </form>
                )}
              </div>
            </div>

            {/* Bottom Row: Micro-Metrics (RPM, TPM & Queue Buffer) */}
            <div className="gemini-hero-footer">
              <div className="hero-micro-item">
                <div className="micro-header">
                  <span className="micro-label">RPM (60s)</span>
                  <span className={`micro-val ${rpmPercent >= 80 ? 'near-limit' : ''}`}>
                    {rpmUsed} / {rpmLimit}
                  </span>
                </div>
                <div className="micro-track">
                  <div
                    className="micro-fill rpm-fill"
                    style={{ width: `${Math.min(100, rpmPercent)}%` }}
                  />
                </div>
              </div>

              <div className="hero-micro-item">
                <div className="micro-header">
                  <span className="micro-label">TPM (Tokens / Min)</span>
                  <span className={`micro-val ${tpmPercent >= 80 ? 'near-limit' : ''}`}>
                    {formatTokens(tpmUsed)} / {formatTokens(tpmLimit)}
                  </span>
                </div>
                <div className="micro-track">
                  <div
                    className="micro-fill tpm-fill"
                    style={{ width: `${Math.min(100, tpmPercent)}%` }}
                  />
                </div>
              </div>

              <div className="hero-micro-item queue-micro-item">
                <div className="micro-header">
                  <span className="micro-label">Fila Resiliente</span>
                  {geminiStatus?.queue.isProcessing && (
                    <span className="queue-live-pill">Processando</span>
                  )}
                </div>
                <div className="queue-micro-body">
                  <span className="queue-micro-count">{geminiStatus?.queue.depth ?? 0}</span>
                  <span className="queue-micro-desc">observações no buffer</span>
                </div>
              </div>
            </div>
          </div>

          {/* Quota Pause Alert Banner */}
          {geminiStatus?.queue.isWaitingForQuota && (
            <div className="gemini-alert-pause">
              <div className="alert-pause-icon">⏳</div>
              <div className="alert-pause-content">
                <strong>Fila temporariamente em pausa preventiva</strong>
                <p>
                  Janela de requisição por minuto saturada. Retomando automaticamente em{' '}
                  <span className="countdown-pill">{countdownSeconds}s</span> sem qualquer perda de dados.
                </p>
              </div>
            </div>
          )}

          {/* Last Switch Event Notice */}
          {geminiStatus?.lastSwitchEvent && (
            <div className="gemini-switch-event-banner">
              <span className="event-tag">Último Chaveamento</span>
              <span className="event-desc">
                Comutado de <code>{geminiStatus.lastSwitchEvent.fromModel}</code> para{' '}
                <code>{geminiStatus.lastSwitchEvent.toModel}</code> em virtude de:{' '}
                <em>{geminiStatus.lastSwitchEvent.reason}</em>
              </span>
            </div>
          )}

          {/* Catalog Filter Toolbar */}
          <div className="gemini-catalog-toolbar">
            <div className="filter-tabs-scroll">
              <button
                type="button"
                className={`catalog-tab-btn ${selectedFilter === 'all' ? 'active' : ''}`}
                onClick={() => setSelectedFilter('all')}
              >
                Todos <span className="tab-counter">{categoryCounts.all}</span>
              </button>
              <button
                type="button"
                className={`catalog-tab-btn ${selectedFilter === 'pro' ? 'active' : ''}`}
                onClick={() => setSelectedFilter('pro')}
              >
                👑 Pro <span className="tab-counter">{categoryCounts.pro}</span>
              </button>
              <button
                type="button"
                className={`catalog-tab-btn ${selectedFilter === 'flash' ? 'active' : ''}`}
                onClick={() => setSelectedFilter('flash')}
              >
                ⚡ Flash <span className="tab-counter">{categoryCounts.flash}</span>
              </button>
              <button
                type="button"
                className={`catalog-tab-btn ${selectedFilter === 'gemma' ? 'active' : ''}`}
                onClick={() => setSelectedFilter('gemma')}
              >
                💎 Gemma <span className="tab-counter">{categoryCounts.gemma}</span>
              </button>
              <button
                type="button"
                className={`catalog-tab-btn ${selectedFilter === 'omni' ? 'active' : ''}`}
                onClick={() => setSelectedFilter('omni')}
              >
                🧠 Omni <span className="tab-counter">{categoryCounts.omni}</span>
              </button>
              <button
                type="button"
                className={`catalog-tab-btn ${selectedFilter === 'lite' ? 'active' : ''}`}
                onClick={() => setSelectedFilter('lite')}
              >
                🪶 Lite <span className="tab-counter">{categoryCounts.lite}</span>
              </button>
            </div>

            {/* Quick Search Field */}
            <div className="gemini-search-wrap">
              <span className="search-icon">🔍</span>
              <input
                type="text"
                className="gemini-search-input"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                placeholder="Filtrar por nome, tier ou spec..."
              />
              {searchTerm && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setSearchTerm('')}
                  title="Limpar busca"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Desktop Table View (>= 768px) */}
          <div className="gemini-desktop-table-container">
            <table className="gemini-table">
              <thead>
                <tr>
                  <th style={{ width: '56px' }}>Rank</th>
                  <th>Modelo & Especificação</th>
                  <th style={{ width: '90px' }}>Categoria</th>
                  <th style={{ width: '80px' }}>Contexto</th>
                  <th style={{ width: '120px' }}>Status</th>
                  <th style={{ width: '110px' }}>RPM (60s)</th>
                  <th style={{ width: '110px' }}>TPM (60s)</th>
                  <th style={{ width: '130px' }}>RPD (Dia)</th>
                  <th style={{ width: '85px', textAlign: 'center' }}>Ação</th>
                </tr>
              </thead>
              <tbody>
                {filteredCascade.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="empty-results-cell">
                      Nenhum modelo encontrado para o filtro aplicado.
                    </td>
                  </tr>
                ) : (
                  filteredCascade.map(model => {
                    const state = geminiStatus?.models[model.id];
                    const isCurrent = model.id === activeModel;
                    const modelRpdUsed = state?.rpdUsed ?? 0;
                    const modelRpdLimit = model.rpdLimit || 1500;
                    const modelRpdPct = Math.min(100, Math.round((modelRpdUsed / modelRpdLimit) * 100));
                    const modelRpmUsed = state?.rpmUsed ?? 0;
                    const modelRpmLimit = model.rpmLimit || 15;
                    const modelRpmPct = Math.min(100, Math.round((modelRpmUsed / modelRpmLimit) * 100));

                    return (
                      <tr key={model.id} className={isCurrent ? 'is-selected-row is-active-model-row' : ''}>
                        <td className="cell-rank">#{model.rank}</td>
                        <td className="cell-name">
                          <div className="name-line">
                            {isCurrent && <span className="active-row-dot" title="Modelo ativo agora" />}
                            <strong>{model.id}</strong>
                            {model.isPerpetualAlias && <span className="badge-perpetual">perpétuo</span>}
                            {model.isPreview && <span className="badge-preview">preview</span>}
                          </div>
                          <span className="name-desc">{model.displayName}</span>
                        </td>
                        <td className="cell-cat">
                          <span className={`cat-pill cat-${model.category}`}>
                            {model.category.toUpperCase()}
                          </span>
                        </td>
                        <td className="cell-ctx">{formatTokens(model.contextWindow)}</td>
                        <td className="cell-status">{getStatusBadge(state)}</td>
                        <td className="cell-meter">
                          <div className="table-meter-wrap">
                            <span className="meter-val">{modelRpmUsed}/{modelRpmLimit}</span>
                            <div className="meter-track">
                              <div
                                className="meter-bar rpm-gradient"
                                style={{ width: `${modelRpmPct}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="cell-meter">
                          <div className="table-meter-wrap">
                            <span className="meter-val">{formatTokens(state?.tpmUsed ?? 0)}/{formatTokens(model.tpmLimit)}</span>
                            <div className="meter-track">
                              <div
                                className="meter-bar tpm-gradient"
                                style={{ width: `${Math.min(100, ((state?.tpmUsed ?? 0) / model.tpmLimit) * 100)}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="cell-meter cell-rpd">
                          <div className="table-meter-wrap">
                            <div className="table-meter-subrow">
                              <span className="meter-val">{modelRpdUsed}/{modelRpdLimit}</span>
                              <span className="meter-pct">{modelRpdPct}%</span>
                            </div>
                            <div className="meter-track">
                              <div
                                className={`meter-bar rpd-gradient ${getUsageLevel(modelRpdPct)}`}
                                style={{ width: `${modelRpdPct}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="cell-action">
                          {isCurrent ? (
                            <span className="active-tag-pill">
                              <span className="active-tag-dot" /> Ativo
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn-select-model"
                              onClick={() => handleModelSelect(model.id)}
                              title={`Definir ${model.id} como modelo preferencial`}
                            >
                              Usar
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile Cards View (< 768px) */}
          <div className="gemini-mobile-cards-container">
            {filteredCascade.length === 0 ? (
              <div className="empty-results-cell">Nenhum modelo encontrado.</div>
            ) : (
              filteredCascade.map(model => {
                const state = geminiStatus?.models[model.id];
                const isCurrent = model.id === activeModel;
                const modelRpdUsed = state?.rpdUsed ?? 0;
                const modelRpdLimit = model.rpdLimit || 1500;
                const modelRpdPct = Math.min(100, Math.round((modelRpdUsed / modelRpdLimit) * 100));

                return (
                  <div key={model.id} className={`gemini-mobile-card ${isCurrent ? 'is-active-card' : ''}`}>
                    <div className="mobile-card-top">
                      <div className="mobile-card-title-wrap">
                        <span className="card-rank">#{model.rank}</span>
                        <strong>{model.id}</strong>
                        {model.isPerpetualAlias && <span className="badge-perpetual">perpétuo</span>}
                        {model.isPreview && <span className="badge-preview">preview</span>}
                      </div>
                      <span className={`cat-pill cat-${model.category}`}>
                        {model.category.toUpperCase()}
                      </span>
                    </div>

                    <div className="mobile-card-sub">
                      <span>{model.displayName}</span>
                      <span>• {formatTokens(model.contextWindow)} ctx</span>
                    </div>

                    {/* Prominent RPD bar in mobile card */}
                    <div className="mobile-card-rpd-block">
                      <div className="mobile-rpd-header">
                        <span className="mobile-rpd-label">RPD (Cota Diária)</span>
                        <span className="mobile-rpd-val">{modelRpdUsed} / {modelRpdLimit} ({modelRpdPct}%)</span>
                      </div>
                      <div className="meter-track">
                        <div
                          className={`meter-bar rpd-gradient ${getUsageLevel(modelRpdPct)}`}
                          style={{ width: `${modelRpdPct}%` }}
                        />
                      </div>
                    </div>

                    <div className="mobile-card-status-row">
                      {getStatusBadge(state)}
                      <div className="mobile-card-meters">
                        <span>RPM: {state?.rpmUsed ?? 0}/{model.rpmLimit}</span>
                      </div>
                    </div>

                    <div className="mobile-card-footer">
                      {isCurrent ? (
                        <span className="active-tag-mobile">⚡ Modelo Ativo Atualmente</span>
                      ) : (
                        <button
                          type="button"
                          className="btn-select-model-mobile"
                          onClick={() => handleModelSelect(model.id)}
                        >
                          Usar este Modelo
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
