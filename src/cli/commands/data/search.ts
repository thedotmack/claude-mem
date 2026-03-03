import { Command } from 'commander';
import { searchService } from '../../services/search-service';
import { Logger } from '../../utils/logger';
import chalk from 'chalk';

export const searchCommand = new Command('search')
  .description('Search memory observations')
  .argument('<query>', 'Search query')
  .option('-p, --project <name>', 'Filter by project')
  .option('-t, --type <type>', 'Filter by type')
  .option('-l, --limit <n>', 'Limit results', '10')
  .option('-j, --json', 'Output as JSON')
  .option('--recent', 'Show recent observations (no query needed)')
  .option('--projects', 'List available projects')
  .action(async (query, options) => {
    const logger = new Logger();

    // List projects
    if (options.projects) {
      const projects = searchService.getProjects();
      logger.title('Available Projects');
      for (const project of projects) {
        console.log(`  ${project}`);
      }
      return;
    }

    // Search
    const limit = parseInt(options.limit, 10) || 10;
    
    const results = options.recent
      ? searchService.getRecent(limit)
      : searchService.search({
          query,
          project: options.project,
          type: options.type,
          limit
        });

    if (results.length === 0) {
      logger.info('No results found');
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    logger.title(`Search Results (${results.length})`);
    console.log('');

    for (const obs of results) {
      const date = obs.createdAt.slice(0, 10);
      const time = obs.createdAt.slice(11, 16);
      const id = chalk.gray(`#${obs.id}`);
      const project = chalk.cyan(obs.project.slice(0, 20));
      const type = chalk.yellow(obs.type);
      
      console.log(`${id} ${chalk.gray(date)} ${project} ${type}`);
      
      // Truncate text to fit terminal
      const text = obs.text.slice(0, 100).replace(/\n/g, ' ');
      console.log(`   ${text}${obs.text.length > 100 ? '...' : ''}`);
      console.log('');
    }
  });
