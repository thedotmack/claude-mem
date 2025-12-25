import { ProcessManager } from '../services/process/ProcessManager.js';
import { getWorkerPort } from '../shared/worker-utils.js';
import { stdin } from 'process';

const command = process.argv[2];
const port = getWorkerPort();

const HOOK_STANDARD_RESPONSE = '{"continue": true, "suppressOutput": true}';
const isManualRun = stdin.isTTY;

async function main() {
  switch (command) {
    case 'start': {
      const result = await ProcessManager.start(port);
      if (result.success) {
        if (isManualRun) {
          console.log(`Worker started (PID: ${result.pid})`);
          const date = new Date().toISOString().slice(0, 10);
          console.log(`Logs: ~/.claude-mem/logs/worker-${date}.log`);
        } else {
          console.log(HOOK_STANDARD_RESPONSE);
        }
        process.exit(0);
      } else {
        console.error(`Failed to start: ${result.error}`);
        process.exit(1);
      }
    }

    case 'stop': {
      await ProcessManager.stop();
      if (isManualRun) {
        console.log('Worker stopped');
      } else {
        console.log(HOOK_STANDARD_RESPONSE);
      }
      process.exit(0);
    }

    case 'restart': {
      const result = await ProcessManager.restart(port);
      if (result.success) {
        if (isManualRun) {
          console.log(`Worker restarted (PID: ${result.pid})`);
        } else {
          console.log(HOOK_STANDARD_RESPONSE);
        }
        process.exit(0);
      } else {
        console.error(`Failed to restart: ${result.error}`);
        process.exit(1);
      }
    }

    case 'status': {
      const status = await ProcessManager.status();
      if (isManualRun) {
        if (status.running) {
          console.log('Worker is running');
          console.log(`  PID: ${status.pid}`);
          console.log(`  Port: ${status.port}`);
          console.log(`  Uptime: ${status.uptime}`);
        } else {
          console.log('Worker is not running');
        }
      } else {
        console.log(HOOK_STANDARD_RESPONSE);
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
