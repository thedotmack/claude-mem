// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useRef, useState } from 'react';
import type { KnowledgeGraphData, KnowledgeGraphNode } from '../../types.js';

interface SimNode extends KnowledgeGraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const CATEGORY_COLORS: Record<KnowledgeGraphNode['category'], string> = {
  self: '#06b6d4',
  user: '#f59e0b',
  fact: '#10b981',
  episode: '#60a5fa',
  concept: '#a855f7',
  summary: '#ec4899',
};

interface Props {
  graph: KnowledgeGraphData;
  onSelectNode?: (node: KnowledgeGraphNode | null) => void;
}

export function KnowledgeGraphCanvas({ graph, onSelectNode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [selected, setSelected] = useState<KnowledgeGraphNode | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = canvas.clientWidth || 620;
    let height = canvas.clientHeight || 480;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const cx = width / 2;
    const cy = height / 2;

    const simNodes: SimNode[] = graph.nodes.map((n, idx) => {
      const angle = (idx / Math.max(1, graph.nodes.length)) * Math.PI * 2;
      const radius = n.category === 'self' ? 0 : n.category === 'user' ? 95 : 140 + (idx % 3) * 42;
      return {
        ...n,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      };
    });

    const nodeById = new Map<string, SimNode>();
    for (const sn of simNodes) nodeById.set(sn.id, sn);

    let dragged: SimNode | null = null;
    let hovered: SimNode | null = null;
    let animFrame = 0;
    let tick = 0;

    const findNodeAt = (mx: number, my: number): SimNode | null => {
      for (let i = simNodes.length - 1; i >= 0; i--) {
        const n = simNodes[i];
        const dx = mx - n.x;
        const dy = my - n.y;
        if (dx * dx + dy * dy <= (n.val + 7) * (n.val + 7)) {
          return n;
        }
      }
      return null;
    };

    const handleMouseDown = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const hit = findNodeAt(ev.clientX - rect.left, ev.clientY - rect.top);
      dragged = hit;
      setSelected(hit);
      onSelectNode?.(hit);
    };

    const handleMouseMove = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      if (dragged) {
        dragged.x = mx;
        dragged.y = my;
        dragged.vx = 0;
        dragged.vy = 0;
      } else {
        hovered = findNodeAt(mx, my);
        canvas.style.cursor = hovered ? 'pointer' : 'grab';
      }
    };

    const handleMouseUp = () => {
      dragged = null;
    };

    const handleResize = () => {
      width = canvas.clientWidth || 620;
      height = canvas.clientHeight || 480;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('resize', handleResize);

    const render = () => {
      tick += 1;

      // Force simulation step
      for (let i = 0; i < simNodes.length; i++) {
        const a = simNodes[i];
        if (a === dragged) continue;

        // Gentle center gravity
        a.vx += (width / 2 - a.x) * (a.category === 'self' ? 0.04 : 0.0022);
        a.vy += (height / 2 - a.y) * (a.category === 'self' ? 0.04 : 0.0022);

        // Coulomb repulsion
        for (let j = i + 1; j < simNodes.length; j++) {
          const b = simNodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distSq = Math.max(80, dx * dx + dy * dy);
          const force = 920 / distSq;
          const dist = Math.sqrt(distSq);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx;
          a.vy += fy;
          if (b !== dragged) {
            b.vx -= fx;
            b.vy -= fy;
          }
        }
      }

      // Hooke spring attraction along synaptic edges
      for (const edge of graph.edges) {
        const s = nodeById.get(edge.source);
        const t = nodeById.get(edge.target);
        if (!s || !t) continue;
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const targetLen = edge.relation === 'social_bond' ? 95 : edge.relation === 'concept' ? 75 : 118;
        const k = 0.015 * Math.max(0.4, edge.weight);
        const f = (dist - targetLen) * k;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        if (s !== dragged) {
          s.vx += fx;
          s.vy += fy;
        }
        if (t !== dragged) {
          t.vx -= fx;
          t.vy -= fy;
        }
      }

      for (const n of simNodes) {
        if (n === dragged) continue;
        n.vx *= 0.84;
        n.vy *= 0.84;
        n.x = Math.max(28, Math.min(width - 28, n.x + n.vx));
        n.y = Math.max(28, Math.min(height - 28, n.y + n.vy));
      }

      // Clear canvas
      ctx.clearRect(0, 0, width, height);

      // Draw edges + travelling synaptic pulses
      for (let eIdx = 0; eIdx < graph.edges.length; eIdx++) {
        const edge = graph.edges[eIdx];
        const s = nodeById.get(edge.source);
        const t = nodeById.get(edge.target);
        if (!s || !t) continue;

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.strokeStyle =
          edge.relation === 'social_bond'
            ? 'rgba(245, 158, 11, 0.55)'
            : 'rgba(100, 116, 139, 0.28)';
        ctx.lineWidth = edge.relation === 'social_bond' ? 2.2 : 1.1;
        ctx.stroke();

        // Animated synaptic action potential pulse
        const phase = ((tick * 0.008 + eIdx * 0.17) % 1 + 1) % 1;
        const px = s.x + (t.x - s.x) * phase;
        const py = s.y + (t.y - s.y) * phase;
        ctx.beginPath();
        ctx.arc(px, py, 2.1, 0, Math.PI * 2);
        ctx.fillStyle = edge.relation === 'social_bond' ? '#fbbf24' : 'rgba(6, 182, 212, 0.72)';
        ctx.fill();
      }

      // Draw nodes
      for (const n of simNodes) {
        const color = CATEGORY_COLORS[n.category];
        const isHot = n === hovered || (selected && selected.id === n.id);

        // Glow halo
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.val + (isHot ? 7 : 3), 0, Math.PI * 2);
        ctx.fillStyle = `${color}28`;
        ctx.fill();

        // Core sphere
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.val, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = isHot ? 2.5 : 1.2;
        ctx.strokeStyle = isHot ? '#ffffff' : 'rgba(255,255,255,0.4)';
        ctx.stroke();

        // Label
        ctx.font = `${n.category === 'self' || n.category === 'user' ? '700 11.5px' : '500 10.5px'} Inter, sans-serif`;
        ctx.fillStyle = '#e2e8f0';
        ctx.textAlign = 'center';
        ctx.fillText(n.label, n.x, n.y + n.val + 14);
      }

      animFrame = requestAnimationFrame(render);
    };

    animFrame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animFrame);
      canvas.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('resize', handleResize);
    };
  }, [graph]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 470 }}>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: 490,
          display: 'block',
          borderRadius: 14,
          background: 'radial-gradient(circle at center, rgba(14, 24, 46, 0.8), rgba(5, 8, 17, 0.96))',
          border: '1px solid rgba(148, 163, 184, 0.14)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          pointerEvents: 'none',
        }}
      >
        {[
          { label: 'MANASA-1', color: '#06b6d4' },
          { label: 'Human User', color: '#f59e0b' },
          { label: 'Personal Fact', color: '#10b981' },
          { label: 'Episodic', color: '#60a5fa' },
          { label: 'Concept Hub', color: '#a855f7' },
          { label: 'REM Summary', color: '#ec4899' },
        ].map(leg => (
          <span
            key={leg.label}
            style={{
              background: 'rgba(6, 9, 17, 0.82)',
              border: '1px solid rgba(148, 163, 184, 0.2)',
              borderRadius: 999,
              padding: '3px 9px',
              fontSize: '0.7rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: leg.color,
                display: 'inline-block',
              }}
            />
            {leg.label}
          </span>
        ))}
      </div>

      {selected && (
        <div
          style={{
            position: 'absolute',
            bottom: 12,
            left: 12,
            right: 12,
            background: 'rgba(9, 14, 26, 0.94)',
            border: '1px solid rgba(6, 182, 212, 0.4)',
            borderRadius: 11,
            padding: '10px 14px',
            fontSize: '0.8rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
            <span>
              [{selected.category.toUpperCase()}] {selected.label}
            </span>
            <span style={{ color: '#fbbf24' }}>ACT-R Strength: {selected.strength}</span>
          </div>
          {selected.subtitle && (
            <div style={{ color: '#94a3b8', marginTop: 3 }}>{selected.subtitle}</div>
          )}
        </div>
      )}
    </div>
  );
}
