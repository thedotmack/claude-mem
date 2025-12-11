import { ProcessManager } from '../services/process/ProcessManager.js';

// During migration, use port 38888 to run alongside the PM2-managed worker on 37777
// Once migration is complete (Phase 3+), this will switch to using settings
const MIGRATION_PORT = 38888;

const command = process.argv[2];
const port = MIGRATION_PORT;

async function main() {
  switch (command) {
    case 'start': {
      const result = await ProcessManager.start(port);
      if (result.success) {
        console.log(`Worker started (PID: ${result.pid})`);
        const date = new Date().toISOString().slice(0, 10);
        console.log(`Logs: ~/.claude-mem/logs/worker-${date}.log`);
      } else {
        console.error(`Failed to start: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'stop': {
      await ProcessManager.stop();
      console.log('Worker stopped');
      break;
    }

    case 'restart': {
      const result = await ProcessManager.restart(port);
      if (result.success) {
        console.log(`Worker restarted (PID: ${result.pid})`);
      } else {
        console.error(`Failed to restart: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'status': {
      const status = await ProcessManager.status();
      if (status.running) {
        console.log('Worker is running');
        console.log(`  PID: ${status.pid}`);
        console.log(`  Port: ${status.port}`);
        console.log(`  Uptime: ${status.uptime}`);
      } else {
        console.log('Worker is not running');
      }
      break;
    }

    default:
      console.log('Usage: worker-cli.js <start|stop|restart|status>');
      process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
