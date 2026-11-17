// Stands in for an agent CLI running one headless turn. It prints "ready" once its SIGINT handler is in place. When
// SIGINT reaches it, it ends the turn and exits 130, as a CLI interrupted by Ctrl+C does. Otherwise it finishes the
// turn by itself after the number of milliseconds given as its one argument, and exits 0.
const turnLengthMs = Number(process.argv[2]);
const say = (line, exitCode) => process.stdout.write(`${line}\n`, () => process.exit(exitCode));
process.on('SIGINT', () => say('the CLI got SIGINT', 130));
process.stdout.write('ready\n');
setTimeout(() => say('the CLI finished its turn', 0), turnLengthMs);
