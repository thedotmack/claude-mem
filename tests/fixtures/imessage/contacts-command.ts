import { runImessageMacCommand } from '../../../src/npx-cli/commands/imessage-mac.js';

process.exitCode = await runImessageMacCommand('contacts', process.argv.slice(2));
