import { ProcessManager } from '../services/process/ProcessManager.js';
import { getWorkerPort } from '../shared/worker-utils.js';

const command = process.argv[2];
const port = getWorkerPort();

async function main() {
  switch (command) {
    case 'start': {
      const result = await ProcessManager.start(port);
      if (result.success) {
        console.log(`Worker started (PID: ${result.pid})`);
        const date = new Date().toISOString().slice(0, 10);
        console.log(`Logs: ~/.claude-mem/logs/worker-${date}.log`);
        process.exit(0);
      } else {
        console.error(`Failed to start: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'stop': {
      await ProcessManager.stop();
      console.log('Worker stopped');
      process.exit(0);
    }

    case 'restart': {
      const result = await ProcessManager.restart(port);
      if (result.success) {
        console.log(`Worker restarted (PID: ${result.pid})`);
        process.exit(0);
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
      process.exit(0);
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
