// Entry point bundled into the request-progress skill's scripts folder.
import { runCli } from './request-groups.mjs';

// `judge` answers with a promise (it calls the Jev judge); every other command answers at once.
Promise.resolve().then(() => runCli(process.argv.slice(2)))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
