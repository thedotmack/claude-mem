// CMEM Viewer — Lucide icon components (inlined path data)
// Outline, 2px stroke, round caps — per the CMEM Agent DS.
// Ported from /tmp/cmem-redesign/cmem-viewer/icons.jsx (no window globals).

import React from 'react';

type SvgTag = 'circle' | 'path' | 'rect' | 'ellipse';
type IconNode = [SvgTag, Record<string, string | number>];

export const ICON_PATHS: Record<string, IconNode[]> = {
  search: [['circle', { cx: 11, cy: 11, r: 8 }], ['path', { d: 'm21 21-4.3-4.3' }]],
  sparkles: [
    ['path', { d: 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z' }],
    ['path', { d: 'M20 3v4' }], ['path', { d: 'M22 5h-4' }]
  ],
  brain: [
    ['path', { d: 'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z' }],
    ['path', { d: 'M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z' }],
    ['path', { d: 'M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4' }]
  ],
  chevronDown: [['path', { d: 'm6 9 6 6 6-6' }]],
  chevronRight: [['path', { d: 'm9 18 6-6-6-6' }]],
  chevronsDownUp: [['path', { d: 'm7 20 5-5 5 5' }], ['path', { d: 'm7 4 5 5 5-5' }]],
  chevronsUpDown: [['path', { d: 'm7 15 5 5 5-5' }], ['path', { d: 'm7 9 5-5 5 5' }]],
  x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  stickyNote: [
    ['path', { d: 'M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z' }],
    ['path', { d: 'M15 3v4a2 2 0 0 0 2 2h4' }]
  ],
  fileCode: [
    ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }],
    ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }],
    ['path', { d: 'm10 13-2 2 2 2' }], ['path', { d: 'm14 17 2-2-2-2' }]
  ],
  pencil: [
    ['path', { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' }],
    ['path', { d: 'm15 5 4 4' }]
  ],
  eye: [
    ['path', { d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' }],
    ['circle', { cx: 12, cy: 12, r: 3 }]
  ],
  clock: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 6v6l4 2' }]],
  messageSquare: [['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }]],
  lightbulb: [
    ['path', { d: 'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5' }],
    ['path', { d: 'M9 18h6' }], ['path', { d: 'M10 22h4' }]
  ],
  bug: [
    ['path', { d: 'm8 2 1.88 1.88' }], ['path', { d: 'M14.12 3.88 16 2' }],
    ['path', { d: 'M9 7.13v-1a3.003 3.003 0 1 1 6 0v1' }],
    ['path', { d: 'M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6' }],
    ['path', { d: 'M12 20v-9' }], ['path', { d: 'M6.53 9C4.6 8.8 3 7.1 3 5' }],
    ['path', { d: 'M6 13H2' }], ['path', { d: 'M3 21c0-2.1 1.7-3.9 3.8-4' }],
    ['path', { d: 'M20.97 5c0 2.1-1.6 3.8-3.5 4' }], ['path', { d: 'M22 13h-4' }],
    ['path', { d: 'M17.2 17c2.1.1 3.8 1.9 3.8 4' }]
  ],
  wrench: [['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' }]],
  zap: [['path', { d: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z' }]],
  gitBranch: [
    ['path', { d: 'M6 3v12' }],
    ['circle', { cx: 18, cy: 6, r: 3 }], ['circle', { cx: 6, cy: 18, r: 3 }],
    ['path', { d: 'M18 9a9 9 0 0 1-9 9' }]
  ],
  trash: [
    ['path', { d: 'M3 6h18' }],
    ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }],
    ['path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
    ['path', { d: 'M10 11v6' }], ['path', { d: 'M14 11v6' }]
  ],
  arrowRight: [['path', { d: 'M5 12h14' }], ['path', { d: 'm12 5 7 7-7 7' }]],
  user: [['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }], ['circle', { cx: 12, cy: 7, r: 4 }]],
  bookmark: [['path', { d: 'm19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z' }]],
  database: [
    ['ellipse', { cx: 12, cy: 5, rx: 9, ry: 3 }],
    ['path', { d: 'M3 5v14a9 3 0 0 0 18 0V5' }],
    ['path', { d: 'M3 12a9 3 0 0 0 18 0' }]
  ],
  history: [
    ['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }],
    ['path', { d: 'M3 3v5h5' }], ['path', { d: 'M12 7v5l4 2' }]
  ],
  folder: [['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }]],
  panelLeft: [
    ['rect', { width: 18, height: 18, x: 3, y: 3, rx: 2 }],
    ['path', { d: 'M9 3v18' }]
  ],
  hash: [
    ['path', { d: 'M4 9h16' }], ['path', { d: 'M4 15h16' }],
    ['path', { d: 'M10 3 8 21' }], ['path', { d: 'M16 3l-2 18' }]
  ]
};

export interface IconProps {
  name: string;
  size?: number;
  strokeWidth?: number;
  style?: React.CSSProperties;
  className?: string;
}

export function Icon({ name, size = 18, strokeWidth = 2, style, className }: IconProps) {
  const nodes = ICON_PATHS[name] || [];
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round"
      style={style} className={className} aria-hidden="true"
    >
      {nodes.map(([tag, attrs], i) => React.createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

// ---------- Observation type metadata ----------
export interface TypeMeta {
  icon: string;
  label: string;
  fg: string;
  bg: string;
}

export const TYPE_META: Record<string, TypeMeta> = {
  feature:   { icon: 'zap',       label: 'feature',   fg: '#D6532F', bg: '#FFE0D2' },
  bugfix:    { icon: 'bug',       label: 'bugfix',    fg: '#C03A28', bg: '#FBE2DD' },
  refactor:  { icon: 'wrench',    label: 'refactor',  fg: '#3E76B5', bg: '#E3EEFA' },
  discovery: { icon: 'lightbulb', label: 'discovery', fg: '#B97714', bg: '#FDEFD6' },
  decision:  { icon: 'gitBranch', label: 'decision',  fg: '#3E7E55', bg: '#E6F3EA' }
};
