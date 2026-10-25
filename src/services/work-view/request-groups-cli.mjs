// Entry point bundled into the request-progress skill's scripts folder.
import { runCli } from './request-groups.mjs';

try { runCli(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
