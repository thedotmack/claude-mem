import { runTranscriptCommand } from './cli.js';

const subcommand = process.argv[2];
const args = process.argv.slice(3);

runTranscriptCommand(subcommand, args)
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
