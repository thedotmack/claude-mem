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
  MarkerType,
} from '@xyflow/react';
import { ProjectGraphData, ProjectNode as ProjectNodeData } from '../../hooks/useGraph';

interface ProjectGraphProps {
  data: ProjectGraphData;
  onNodeClick?: (projectId: string) => void;
}

// Custom node component for projects
function ProjectNodeComponent({ data }: { data: { id: string; observationCount: number; conceptCount: number; topTypes: { type: string; count: number }[] } }) {
  const nodeSize = Math.max(80, Math.min(160, 60 + data.observationCount * 0.5));

  return (
    <div
      className="project-node"
      style={{
        width: nodeSize,
        minHeight: nodeSize * 0.8,
        padding: 12,
        borderRadius: 12,
        background: 'linear-gradient(135deg, var(--color-bg-card) 0%, var(--color-bg-secondary) 100%)',
        border: '2px solid var(--color-accent-primary)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        cursor: 'pointer',
        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
      }}
      title={`${data.id}\n${data.observationCount} observations\n${data.conceptCount} concepts`}
    >
      <div style={{
        fontSize: Math.max(10, Math.min(14, 8 + nodeSize / 20)),
        fontWeight: 600,
        color: 'var(--color-text-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: '100%',
        textAlign: 'center',
      }}>
        {data.id}
      </div>
      <div style={{
        display: 'flex',
        gap: 8,
        fontSize: 10,
        color: 'var(--color-text-secondary)',
      }}>
        <span>{data.observationCount} obs</span>
        <span>{data.conceptCount} concepts</span>
      </div>
      {data.topTypes.length > 0 && (
        <div style={{
          display: 'flex',
          gap: 4,
          flexWrap: 'wrap',
          justifyContent: 'center',
          marginTop: 4,
        }}>
          {data.topTypes.slice(0, 3).map(({ type, count }) => (
            <span
              key={type}
              style={{
                fontSize: 8,
                padding: '2px 4px',
                background: 'var(--color-bg-tertiary)',
                borderRadius: 4,
                color: 'var(--color-text-muted)',
              }}
            >
              {type}: {count}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const nodeTypes = {
  project: ProjectNodeComponent,
};

export function ProjectGraph({ data, onNodeClick }: ProjectGraphProps) {
  const { initialNodes, initialEdges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    // Simple circular layout for projects
    const nodeCount = data.nodes.length;
    const radius = Math.max(200, nodeCount * 80);

    data.nodes.forEach((project, index) => {
      const angle = (index / nodeCount) * 2 * Math.PI;
      const x = Math.cos(angle) * radius + radius + 100;
      const y = Math.sin(angle) * radius + radius + 100;

      nodes.push({
        id: project.id,
        type: 'project',
        position: { x, y },
        data: {
          id: project.id,
          observationCount: project.observationCount,
          conceptCount: project.conceptCount,
          topTypes: project.topTypes,
        },
      });
    });

    // Create edges for shared concepts
    data.edges.forEach((edge, index) => {
      const edgeWidth = Math.min(6, 1 + edge.weight * 0.3);

      edges.push({
        id: `e-${index}`,
        source: edge.source,
        target: edge.target,
        type: 'default',
        animated: true,
        style: {
          stroke: 'var(--color-accent-primary)',
          strokeWidth: edgeWidth,
          opacity: Math.min(0.8, 0.3 + edge.weight * 0.05),
        },
        label: `${edge.sharedConcepts.length} shared`,
        labelStyle: {
          fontSize: 10,
          fill: 'var(--color-text-secondary)',
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 15,
          height: 15,
          color: 'var(--color-accent-primary)',
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
        No projects found.
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
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.2}
        maxZoom={2}
        attributionPosition="bottom-left"
      >
        <Controls showInteractive={false} />
        <Background color="var(--color-border-primary)" gap={20} />
      </ReactFlow>

      <div className="graph-stats-overlay">
        <div className="stats-row">
          <span className="stat">{data.stats.totalProjects} projects</span>
          <span className="stat">{data.stats.totalConnections} connections</span>
        </div>
        {data.stats.mostConnected.length > 0 && (
          <div className="most-connected">
            Most connected: {data.stats.mostConnected.slice(0, 2).join(', ')}
          </div>
        )}
      </div>
    </div>
  );
}
