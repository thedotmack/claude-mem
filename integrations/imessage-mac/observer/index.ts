import { createGrpcClient } from './photon-sdk.cjs';
import { runImessageMacCommand } from '../../../src/npx-cli/commands/imessage-mac';
import { runPhotonAppCommand } from '../../../src/npx-cli/commands/imessage';

// Only these observer commands run with the app's permissions. A worker is
// started independently, and Photon always uses the SDK compiled into this binary.
const [command, source, action, ...args] = process.argv.slice(2);
try {
  if (command !== 'imessage') throw new Error('Expected an iMessage observer command.');
  if (source === 'mac') process.exitCode = await runImessageMacCommand(action, args, false);
  else if (source === 'photon') process.exitCode = await runPhotonAppCommand(action, args, { createGrpcClient });
  else throw new Error('Select Messages on this Mac or Photon.');
} catch (error) {
  const message = error instanceof Error ? error.message : 'Could not run the observer.';
  process.stdout.write(JSON.stringify({ type: 'error', reason: 'observer', message }) + '\n');
  process.exitCode = 1;
}
