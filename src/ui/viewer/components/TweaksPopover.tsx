// CMEM Viewer — appearance tweaks (accent / density / roundness).
//
// This is the SMALL in-app popover replacement for the design-tool
// `tweaks-panel.jsx` shell. It does NOT use the postMessage host protocol.
// State persists to localStorage (`cmem-viewer-tweaks-v1`) and is applied to
// the document root as CSS variables (--accent / --accent-deep / --accent-soft
// / --accent-tint / --rs) plus a `data-density` attribute.
//
// ACCENTS + VIEWER_TWEAK_DEFAULTS ported from app-v4.jsx:6-16.

import React, { useCallback, useEffect, useState } from 'react';
import { Icon } from '../ui/icons.js';

export interface Accent {
  a: string;
  deep: string;
  soft: string;
  tint: string;
}

export const ACCENTS: Record<string, Accent> = {
  coral: { a: '#FF6B47', deep: '#F2543D', soft: '#FFE0D2', tint: '#FFF1EB' },
  ember: { a: '#F2543D', deep: '#D63E2C', soft: '#FFD9CE', tint: '#FFEEE8' },
  honey: { a: '#F59A3C', deep: '#DD7F1E', soft: '#FFE5C2', tint: '#FFF4E4' }
};

export type Density = 'cozy' | 'compact';

export interface ViewerTweaks {
  density: Density;
  accent: string;
  roundness: number;
}

export const VIEWER_TWEAK_DEFAULTS: ViewerTweaks = {
  density: 'cozy',
  accent: '#FF6B47',
  roundness: 1
};

export const TWEAKS_KEY = 'cmem-viewer-tweaks-v1';

function accentFor(value: string): Accent {
  return Object.values(ACCENTS).find((a) => a.a === value) || ACCENTS.coral;
}

/** Apply tweaks to the document root: CSS variables + data-density. */
export function applyTweaks(tweaks: ViewerTweaks): void {
  const root = document.documentElement;
  const accent = accentFor(tweaks.accent);
  root.style.setProperty('--accent', accent.a);
  root.style.setProperty('--accent-deep', accent.deep);
  root.style.setProperty('--accent-soft', accent.soft);
  root.style.setProperty('--accent-tint', accent.tint);
  root.style.setProperty('--rs', String(tweaks.roundness));
  root.setAttribute('data-density', tweaks.density);
}

function readStored(): ViewerTweaks {
  try {
    const raw = localStorage.getItem(TWEAKS_KEY);
    if (raw) return { ...VIEWER_TWEAK_DEFAULTS, ...(JSON.parse(raw) as Partial<ViewerTweaks>) };
  } catch (e) {
    /* ignore */
  }
  return VIEWER_TWEAK_DEFAULTS;
}

export interface UseTweaks {
  tweaks: ViewerTweaks;
  setTweak: <K extends keyof ViewerTweaks>(key: K, value: ViewerTweaks[K]) => void;
}

export function useTweaks(): UseTweaks {
  const [tweaks, setTweaks] = useState<ViewerTweaks>(readStored);

  // Persist + apply to root whenever tweaks change (also covers mount).
  useEffect(() => {
    try {
      localStorage.setItem(TWEAKS_KEY, JSON.stringify(tweaks));
    } catch (e) {
      /* ignore */
    }
    applyTweaks(tweaks);
  }, [tweaks]);

  const setTweak = useCallback(
    <K extends keyof ViewerTweaks>(key: K, value: ViewerTweaks[K]) => {
      setTweaks((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  return { tweaks, setTweak };
}

export interface TweaksPopoverProps {
  open: boolean;
  onClose: () => void;
  tweaks: ViewerTweaks;
  setTweak: UseTweaks['setTweak'];
}

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  top: 56,
  right: 16,
  zIndex: 120,
  width: 264,
  background: 'var(--surface)',
  border: '1px solid var(--hairline, var(--border))',
  borderRadius: 'var(--rr-lg, 14px)',
  boxShadow: 'var(--shadow-lg)',
  padding: 'var(--space-4, 16px)',
  fontFamily: 'var(--font-sans)',
  color: 'var(--fg)'
};

export function TweaksPopover({ open, onClose, tweaks, setTweak }: TweaksPopoverProps) {
  if (!open) return null;
  const densities: Density[] = ['cozy', 'compact'];
  return (
    <React.Fragment>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 110, background: 'transparent' }}
        aria-hidden="true"
      />
      <div className="tweaks-popover" style={panelStyle} role="dialog" aria-label="Appearance">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 'var(--space-3, 12px)'
          }}
        >
          <p
            className="cm-eyebrow"
            style={{ fontWeight: 600, fontSize: '0.8rem', color: 'var(--fg-2)', margin: 0 }}
          >
            Appearance
          </p>
          <button className="icon-btn" onClick={onClose} aria-label="Close appearance">
            <Icon name="x" size={15} />
          </button>
        </div>

        {/* Accent */}
        <div style={{ marginBottom: 'var(--space-4, 16px)' }}>
          <p style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--fg-3)', margin: '0 0 8px' }}>
            Accent
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            {Object.entries(ACCENTS).map(([name, acc]) => {
              const active = tweaks.accent === acc.a;
              return (
                <button
                  key={name}
                  onClick={() => setTweak('accent', acc.a)}
                  title={name}
                  aria-label={name}
                  aria-pressed={active}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: '50%',
                    background: acc.a,
                    border: active ? '2px solid var(--fg)' : '2px solid var(--border)',
                    boxShadow: active ? '0 0 0 3px ' + acc.tint : 'none',
                    cursor: 'pointer'
                  }}
                />
              );
            })}
          </div>
        </div>

        {/* Density */}
        <div style={{ marginBottom: 'var(--space-4, 16px)' }}>
          <p style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--fg-3)', margin: '0 0 8px' }}>
            Density
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            {densities.map((d) => {
              const active = tweaks.density === d;
              return (
                <button
                  key={d}
                  onClick={() => setTweak('density', d)}
                  className={'type-chip' + (active ? ' active' : '')}
                  style={
                    active
                      ? { background: 'var(--accent)', color: 'var(--fg-on-coral)', borderColor: 'transparent', textTransform: 'capitalize' }
                      : { textTransform: 'capitalize' }
                  }
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>

        {/* Roundness */}
        <div>
          <p style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--fg-3)', margin: '0 0 8px' }}>
            Roundness
          </p>
          <input
            type="range"
            min={0.6}
            max={1.25}
            step={0.05}
            value={tweaks.roundness}
            onChange={(e) => setTweak('roundness', Number(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
            aria-label="Roundness"
          />
        </div>
      </div>
    </React.Fragment>
  );
}
