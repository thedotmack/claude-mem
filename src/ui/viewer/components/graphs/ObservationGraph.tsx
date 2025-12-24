import React, { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Node,
  Edge,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  ConnectionLineType,
} from '@xyflow/react';
import { ObservationGraphData, ObservationNode as ObservationNodeData } from '../../hooks/useGraph';

interface ObservationGraphProps {
  data: ObservationGraphData;
  onNodeClick?: (observationId: number) => void;
}

// Type colors matching the viewer theme
const TYPE_COLORS: Record<string, string> = {
  bugfix: '#d73a4a',
  feature: '#8250df',
  refactor: '#1f6feb',
  change: '#1a7f37',
  discovery: '#0969da',
  decision: '#bf8700',
};

const TYPE_ICONS: Record<string, string> = {
  bugfix: '🔴',
  feature: '🟣',
  refactor: '🔄',
  change: '✅',
  discovery: '🔵',
  decision: '⚖️',
};

// Custom node component for observations
function ObservationNodeComponent({ data }: { data: { id: number; title: string; type: string; usageCount: number } }) {
  const color = TYPE_COLORS[data.type] || '#666';
  const icon = TYPE_ICONS[data.type] || '•';
  const hasUsage = data.usageCount > 0;

  return (
    <div
      className="observation-node"
      style={{
        minWidth: 120,
        maxWidth: 180,
        padding: '8px 12px',
        borderRadius: 8,
        background: 'var(--color-bg-card)',
        border: `2px solid ${color}`,
        boxShadow: hasUsage ? `0 0 8px ${color}40` : '0 2px 4px rgba(0,0,0,0.1)',
        cursor: 'pointer',
        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
      }}
      title={`#${data.id}: ${data.title}\nType: ${data.type}\nUsed: ${data.usageCount} times`}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginBottom: 4,
      }}>
        <span style={{ fontSize: 12 }}>{icon}</span>
        <span style={{
          fontSize: 10,
          color: color,
          fontWeight: 600,
          textTransform: 'uppercase',
        }}>
          {data.type}
        </span>
        {hasUsage && (
          <span style={{
            fontSize: 9,
            background: '#1a7f37',
            color: 'white',
            padding: '1px 4px',
            borderRadius: 8,
            marginLeft: 'auto',
          }}>
            {data.usageCount}x
          </span>
        )}
      </div>
      <div style={{
        fontSize: 11,
        color: 'var(--color-text-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontWeight: 500,
      }}>
        {data.title}
      </div>
    </div>
  );
}

const nodeTypes = {
  observation: ObservationNodeComponent,
};

// Relationship colors
const RELATIONSHIP_COLORS: Record<string, string> = {
  shared_concept: '#8250df',
  shared_file: '#1f6feb',
  same_session: '#1a7f37',
  semantic_similar: '#bf8700',
};

export function ObservationGraph({ data, onNodeClick }: ObservationGraphProps) {
  const { initialNodes, initialEdges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    // Group by session for clustering
    const sessionGroups = new Map<string, ObservationNodeData[]>();
    // Note: We don't have sdk_session_id in the node data, so we'll use type-based grouping
    const typeGroups = new Map<string, ObservationNodeData[]>();

    data.nodes.forEach(obs => {
      const type = obs.type;
      if (!typeGroups.has(type)) {
        typeGroups.set(type, []);
      }
      typeGroups.get(type)!.push(obs);
    });

    // Position nodes by type cluster
    let globalIndex = 0;
    const typeArray = Array.from(typeGroups.entries());
    const clusterRadius = 150;
    const typeRadius = Math.max(300, typeArray.length * 100);

    typeArray.forEach(([type, observations], typeIndex) => {
      const typeAngle = (typeIndex / typeArray.length) * 2 * Math.PI;
      const typeCenterX = Math.cos(typeAngle) * typeRadius + typeRadius + 200;
      const typeCenterY = Math.sin(typeAngle) * typeRadius + typeRadius + 200;

      observations.forEach((obs, obsIndex) => {
        const obsAngle = (obsIndex / observations.length) * 2 * Math.PI;
        const r = clusterRadius * (0.3 + (obsIndex / Math.max(1, observations.length - 1)) * 0.7);
        const x = typeCenterX + Math.cos(obsAngle) * r;
        const y = typeCenterY + Math.sin(obsAngle) * r;

        nodes.push({
          id: String(obs.id),
          type: 'observation',
          position: { x, y },
          data: {
            id: obs.id,
            title: obs.title,
            type: obs.type,
            usageCount: obs.usageCount,
          },
        });

        globalIndex++;
      });
    });

    // Limit edges for performance (show strongest connections)
    const sortedEdges = [...data.edges].sort((a, b) => b.weight - a.weight);
    const maxEdges = Math.min(200, sortedEdges.length);

    sortedEdges.slice(0, maxEdges).forEach((edge, index) => {
      const color = RELATIONSHIP_COLORS[edge.relationship] || '#666';

      edges.push({
        id: `e-${index}`,
        source: String(edge.source),
        target: String(edge.target),
        type: 'default',
        animated: edge.relationship === 'same_session',
        style: {
          stroke: color,
          strokeWidth: Math.min(3, edge.weight),
          opacity: 0.4 + Math.min(0.4, edge.weight * 0.1),
        },
      });
    });

    return { initialNodes: nodes, initialEdges: edges };
  }, [data]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const handleNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    if (onNodeClick) {
      onNodeClick(parseInt(node.id, 10));
    }
  }, [onNodeClick]);

  if (data.nodes.length === 0) {
    return (
      <div className="graph-empty">
        No observations found.
      </div>
    );
  }

  return (
    <div className="react-flow-wrapper">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        connectionLineType={ConnectionLineType.SmoothStep}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.05}
        maxZoom={2}
        attributionPosition="bottom-left"
      >
        <Controls showInteractive={false} />
        <Background color="var(--color-border-primary)" gap={20} />
      </ReactFlow>

      <div className="graph-stats-overlay">
        <div className="stats-row">
          <span className="stat">{data.stats.totalObservations} observations</span>
          <span className="stat">{data.stats.totalEdges} edges</span>
        </div>
        <div className="legend-row">
          {Object.entries(RELATIONSHIP_COLORS).map(([rel, color]) => (
            <span key={rel} className="legend-item" style={{ color }}>
              <span className="legend-dot" style={{ background: color }}></span>
              {rel.replace('_', ' ')}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
