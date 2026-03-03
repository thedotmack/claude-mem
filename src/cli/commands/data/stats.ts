import { Command } from 'commander';
import { statsService } from '../../services/stats-service';
import { Logger } from '../../utils/logger';
import { formatBytes } from '../../utils/format';

export const statsCommand = new Command('stats')
  .description('Show database statistics')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    const logger = new Logger();

    if (!statsService.isDatabaseAccessible()) {
      logger.error('Database not found');
      process.exit(1);
    }

    const dbStats = statsService.getDatabaseStats();
    const activityStats = statsService.getActivityStats(30);
    const topProjects = statsService.getTopProjects(5);
    const obsTypes = statsService.getObservationTypes();

    if (options.json) {
      console.log(JSON.stringify({
        database: dbStats,
        activity: activityStats,
        topProjects,
        observationTypes: obsTypes
      }, null, 2));
      return;
    }

    logger.title('Claude-Mem Statistics');

    // Database stats
    if (dbStats) {
      logger.section('Database');
      console.log(`  Total Observations:  ${dbStats.observations.toLocaleString()}`);
      console.log(`  Total Sessions:      ${dbStats.sessions.toLocaleString()}`);
      console.log(`  Session Summaries:   ${dbStats.summaries.toLocaleString()}`);
      console.log(`  Database Size:       ${formatBytes(dbStats.databaseSize)}`);
    }

    // Activity stats
    if (activityStats) {
      logger.section('Activity (Last 30 Days)');
      console.log(`  Sessions:            ${activityStats.totalSessions}`);
      console.log(`  Observations:        ${activityStats.totalObservations}`);
      console.log(`  Avg per Session:     ${activityStats.avgObservationsPerSession}`);
      if (activityStats.firstSessionDate) {
        console.log(`  First Session:       ${activityStats.firstSessionDate}`);
      }
    }

    // Top projects
    if (topProjects && topProjects.length > 0) {
      logger.section('Top Projects');
      for (let i = 0; i < topProjects.length; i++) {
        const p = topProjects[i];
        console.log(`  ${i + 1}. ${p.name.slice(0, 30).padEnd(30)} ${p.sessions.toString().padStart(4)} sess  ${p.observations.toString().padStart(5)} obs`);
      }
    }

    // Observation types
    if (obsTypes && obsTypes.length > 0) {
      logger.section('Observation Types');
      for (const type of obsTypes.slice(0, 6)) {
        console.log(`  ${type.type.padEnd(15)} ${type.count.toLocaleString().padStart(6)}`);
      }
    }
  });
