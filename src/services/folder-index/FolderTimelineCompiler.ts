/**
 * FolderTimelineCompiler - Build timeline view of folder activity
 *
 * Queries observations and sessions touching files in a folder,
 * groups them chronologically for timeline display.
 */

import { SessionSearch } from '../sqlite/SessionSearch.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import type {
  ObservationSearchResult,
  SessionSummarySearchResult,
} from '../sqlite/types.js';
import type { FolderTimelineContent, TimelineObservation } from './types.js';

/**
 * Compile timeline of all activity in a folder
 *
 * Uses SessionSearch.findByFile() to retrieve observations and sessions
 * that touched files in the specified folder path.
 */
export async function compileTimeline(
  project: string,
  folderPath: string
): Promise<FolderTimelineContent> {
  const store = new SessionStore();
  const search = new SessionSearch(store.db.filename);

  try {
    // Query all observations and sessions for this folder
    const { observations, sessions } = search.findByFile(folderPath, {
      project,
      limit: 1000, // Get comprehensive history
      orderBy: 'date_desc',
    });

    // Group observations by date
    const timelineMap = new Map<string, TimelineObservation[]>();

    // Process observations
    for (const obs of observations) {
      const date = new Date(obs.created_at_epoch).toISOString().split('T')[0];
      if (!timelineMap.has(date)) {
        timelineMap.set(date, []);
      }

      const files = [
        ...(obs.files_read ? JSON.parse(obs.files_read) : []),
        ...(obs.files_modified ? JSON.parse(obs.files_modified) : []),
      ].filter((file: string) => file.includes(folderPath));

      timelineMap.get(date)!.push({
        type: obs.type,
        title: obs.title || 'Untitled observation',
        files,
        summary: obs.narrative || obs.subtitle || 'No summary available',
      });
    }

    // Process session summaries
    for (const session of sessions) {
      const date = new Date(session.created_at_epoch)
        .toISOString()
        .split('T')[0];
      if (!timelineMap.has(date)) {
        timelineMap.set(date, []);
      }

      const files = [
        ...(session.files_read ? JSON.parse(session.files_read) : []),
        ...(session.files_edited ? JSON.parse(session.files_edited) : []),
      ].filter((file: string) => file.includes(folderPath));

      timelineMap.get(date)!.push({
        type: 'session',
        title: session.request || 'Session summary',
        files,
        summary: session.completed || session.learned || 'No summary available',
      });
    }

    // Build sorted timeline
    const timeline = Array.from(timelineMap.entries())
      .map(([date, observations]) => ({ date, observations }))
      .sort((a, b) => b.date.localeCompare(a.date)); // Most recent first

    // Find most recent timestamp
    const allTimestamps = [
      ...observations.map((o) => o.created_at_epoch),
      ...sessions.map((s) => s.created_at_epoch),
    ];
    const lastUpdatedEpoch = Math.max(...allTimestamps, 0);

    return {
      folderPath,
      lastUpdated: new Date(lastUpdatedEpoch).toISOString(),
      observationCount: observations.length + sessions.length,
      timeline,
    };
  } finally {
    search.close();
    store.close();
  }
}
