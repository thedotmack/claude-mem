import React, { useState, useCallback, useRef } from 'react';
import type { ActivityDay } from '../types';

interface ActivityBarProps {
  days: ActivityDay[];
  dateStart: string;
  dateEnd: string;
  onDateRangeSelect: (start: string, end: string) => void;
  isLoading: boolean;
}

export function ActivityBar({ days, dateStart, dateEnd, onDateRangeSelect, isLoading }: ActivityBarProps) {
  const [tooltip, setTooltip] = useState<{ day: ActivityDay; dateLabel: string; x: number; y: number; containerWidth: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // Use refs for drag state so handlers always see current values synchronously
  const dragStartRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);

  const maxCount = Math.max(1, ...days.map(d => d.count));

  const isInRange = useCallback((date: string) => {
    if (!dateStart && !dateEnd) return false;
    if (dateStart && date < dateStart) return false;
    if (dateEnd && date > dateEnd) return false;
    return true;
  }, [dateStart, dateEnd]);

  const handleMouseDown = useCallback((index: number) => {
    dragStartRef.current = index;
    isDraggingRef.current = false;
  }, []);

  const handleMouseMove = useCallback((index: number) => {
    if (dragStartRef.current !== null && dragStartRef.current !== index) {
      isDraggingRef.current = true;
    }
  }, []);

  const handleMouseUp = useCallback((index: number) => {
    const startIdx = dragStartRef.current;
    if (startIdx === null) return;

    if (isDraggingRef.current) {
      // Drag: select range
      const lo = Math.min(startIdx, index);
      const hi = Math.max(startIdx, index);
      const startDate = days[lo]?.date ?? '';
      const endDate = days[hi]?.date ?? '';
      onDateRangeSelect(startDate, endDate);
    } else {
      // Click: toggle single day
      const date = days[index]?.date ?? '';
      if (dateStart === date && dateEnd === date) {
        onDateRangeSelect('', '');
      } else {
        onDateRangeSelect(date, date);
      }
    }

    dragStartRef.current = null;
    isDraggingRef.current = false;
  }, [days, dateStart, dateEnd, onDateRangeSelect]);

  const handleMouseEnter = useCallback((day: ActivityDay, index: number, e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Track drag movement
    handleMouseMove(index);
    const dateLabel = new Date(day.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const rawX = e.clientX - rect.left;
    setTooltip({
      day,
      dateLabel,
      x: rawX,
      y: -28,
      containerWidth: rect.width,
    });
  }, [handleMouseMove]);

  const handleColumnMouseLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  const handleContainerMouseLeave = useCallback(() => {
    dragStartRef.current = null;
    isDraggingRef.current = false;
    setTooltip(null);
  }, []);

  if (isLoading) {
    return <div className="activity-bar activity-bar-loading">Loading activity...</div>;
  }

  if (days.length === 0) return null;

  return (
    <div className="activity-bar" ref={containerRef} role="figure" aria-label="Activity timeline" onMouseLeave={handleContainerMouseLeave}>
      {days.map((day, i) => {
        const height = day.count > 0 ? Math.max(4, (day.count / maxCount) * 100) : 0;
        const obsHeight = day.count > 0 ? (day.observations / day.count) * height : 0;
        const sumHeight = day.count > 0 ? (day.summaries / day.count) * height : 0;
        const promptHeight = height - obsHeight - sumHeight;
        const inRange = isInRange(day.date);

        return (
          <div
            key={day.date}
            className={`activity-bar-column ${inRange ? 'selected' : ''}`}
            style={{ height: '100%' }}
            onMouseDown={() => { handleMouseDown(i); }}
            onMouseUp={() => { handleMouseUp(i); }}
            onMouseEnter={e => { handleMouseEnter(day, i, e); }}
            onMouseLeave={handleColumnMouseLeave}
            role="button"
            aria-label={`${day.date}: ${String(day.count)} items`}
            tabIndex={0}
          >
            <div className="activity-bar-stack" style={{ height: `${String(height)}%` }}>
              {obsHeight > 0 && (
                <div className="activity-bar-segment activity-bar-obs" style={{ flex: obsHeight }} />
              )}
              {sumHeight > 0 && (
                <div className="activity-bar-segment activity-bar-summary" style={{ flex: sumHeight }} />
              )}
              {promptHeight > 0 && (
                <div className="activity-bar-segment activity-bar-prompt" style={{ flex: promptHeight }} />
              )}
            </div>
          </div>
        );
      })}
      {tooltip && (() => {
        // Shift tooltip anchor from center (-50%) toward left (-100%) near right edge,
        // and toward right (0%) near left edge, to prevent overflow on either side.
        const ratio = tooltip.containerWidth > 0 ? tooltip.x / tooltip.containerWidth : 0.5;
        const translatePct = ratio > 0.85 ? -95 : ratio > 0.7 ? -70 : ratio < 0.15 ? -5 : ratio < 0.3 ? -30 : -50;
        return (
        <div
          ref={tooltipRef}
          className="activity-bar-tooltip"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: `translateX(${String(translatePct)}%)`,
          }}
        >
          <span className="activity-bar-tooltip-date">{tooltip.dateLabel}</span>
          {tooltip.day.count > 0 ? (
            <>
              {tooltip.day.observations > 0 && (
                <span className="activity-bar-tooltip-item">
                  <span className="activity-bar-legend activity-bar-legend-obs" />
                  {tooltip.day.observations} obs
                </span>
              )}
              {tooltip.day.summaries > 0 && (
                <span className="activity-bar-tooltip-item">
                  <span className="activity-bar-legend activity-bar-legend-summary" />
                  {tooltip.day.summaries} sum
                </span>
              )}
              {tooltip.day.prompts > 0 && (
                <span className="activity-bar-tooltip-item">
                  <span className="activity-bar-legend activity-bar-legend-prompt" />
                  {tooltip.day.prompts} prompt
                </span>
              )}
            </>
          ) : (
            <span style={{ opacity: 0.6 }}>no activity</span>
          )}
        </div>
        );
      })()}
    </div>
  );
}
