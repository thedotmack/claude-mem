import React, { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Node,
  Edge,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  ConnectionLineType,
} from '@xyflow/react';
import { ConceptGraphData, ConceptNode as ConceptNodeData } from '../../hooks/useGraph';

interface ConceptGraphProps {
  data: ConceptGraphData;
  onNodeClick?: (conceptId: string) => void;
}

// Custom node component for concepts
function ConceptNodeComponent({ data }: { data: { label: string; size: number; projects: string[] } }) {
  const nodeSize = Math.max(40, Math.min(100, 30 + data.size * 5));

  return (
    <div
      className="concept-node"
      style={{
        width: nodeSize,
        height: nodeSize,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        fontSize: Math.max(9, Math.min(14, 8 + data.size)),
        padding: 4,
        background: `linear-gradient(135deg, var(--color-accent-primary), var(--color-accent-focus))`,
        color: 'white',
        fontWeight: 500,
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        cursor: 'pointer',
        transition: 'transform 0.2s ease',
      }}
      title={`${data.label} (${data.size} observations)\nProjects: ${data.projects.join(', ')}`}
    >
      <span style={{
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: nodeSize - 8
      }}>
        {data.label}
      </span>
    </div>
  );
}

const nodeTypes = {
  concept: ConceptNodeComponent,
};

export function ConceptGraph({ data, onNodeClick }: ConceptGraphProps) {
  // Convert concept data to React Flow nodes
  const { initialNodes, initialEdges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    // Position nodes in a force-directed-like layout using a simple algorithm
    const nodeCount = data.nodes.length;
    const radius = Math.max(200, nodeCount * 15);

    data.nodes.forEach((concept, index) => {
      // Spiral layout for better distribution
      const angle = (index / nodeCount) * 2 * Math.PI * 3; // 3 rotations
      const r = radius * (0.3 + (index / nodeCount) * 0.7);
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;

      nodes.push({
        id: concept.id,
        type: 'concept',
        position: { x: x + radius, y: y + radius },
        data: {
          label: concept.label,
          size: concept.size,
          projects: concept.projects,
        },
      });
    });

    // Create edges
    data.edges.forEach((edge, index) => {
      edges.push({
        id: `e-${index}`,
        source: edge.source,
        target: edge.target,
        type: 'default',
        animated: false,
        style: {
          stroke: 'var(--color-border-primary)',
          strokeWidth: Math.min(4, 1 + edge.weight * 0.5),
          opacity: Math.min(0.8, 0.2 + edge.weight * 0.1),
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 10,
          height: 10,
          color: 'var(--color-border-primary)',
        },
      });
    });

    return { initialNodes: nodes, initialEdges: edges };
  }, [data]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const handleNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    if (onNodeClick) {
      onNodeClick(node.id);
    }
  }, [onNodeClick]);

  if (data.nodes.length === 0) {
    return (
      <div className="graph-empty">
        No concepts found. Observations need concept tags to appear here.
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
        minZoom={0.1}
        maxZoom={2}
        attributionPosition="bottom-left"
      >
        <Controls showInteractive={false} />
        <Background color="var(--color-border-primary)" gap={20} />
      </ReactFlow>

      <div className="graph-stats-overlay">
        <div className="stats-row">
          <span className="stat">{data.stats.totalConcepts} concepts</span>
          <span className="stat">{data.stats.totalEdges} connections</span>
        </div>
        {data.stats.mostConnected.length > 0 && (
          <div className="most-connected">
            Top: {data.stats.mostConnected.slice(0, 3).join(', ')}
          </div>
        )}
      </div>
    </div>
  );
}
