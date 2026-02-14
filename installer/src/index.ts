import * as p from '@clack/prompts';
import { runWelcome } from './steps/welcome.js';

async function runInstaller(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('Error: This installer requires an interactive terminal.');
    console.error('Run directly: npx claude-mem-installer');
    process.exit(1);
  }

  const installMode = await runWelcome();

  // Future phases will add steps here based on installMode
  p.log.info(`Selected mode: ${installMode}`);

  p.outro('Setup will continue in upcoming phases.');
}

runInstaller().catch((error) => {
  p.cancel('Installation failed.');
  console.error(error);
  process.exit(1);
});
