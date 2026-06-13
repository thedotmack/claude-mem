// CMEM Viewer — formatting helpers.
// Ported from /tmp/cmem-redesign/cmem-viewer/icons.jsx:116-140 (exact behavior).

export const fmtTime = (epoch: number): string =>
  new Date(epoch * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const fmtDayKey = (epoch: number): string => {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export interface DayLabel {
  lead: string;
  rest: string;
}

export const fmtDayLabel = (epoch: number): DayLabel => {
  const d = new Date(epoch * 1000);
  const now = new Date();
  const today = fmtDayKey(now.getTime() / 1000);
  const yest = fmtDayKey(now.getTime() / 1000 - 86400);
  const key = fmtDayKey(epoch);
  const label = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  if (key === today) return { lead: 'Today', rest: label };
  if (key === yest) return { lead: 'Yesterday', rest: label };
  return { lead: d.toLocaleDateString([], { weekday: 'long' }), rest: d.toLocaleDateString([], { month: 'long', day: 'numeric' }) };
};

export const baseName = (path: string): string => path.split('/').pop() ?? path;

export const dirName = (path: string): string => {
  const parts = path.split('/');
  return parts.slice(0, -1).join('/');
};
