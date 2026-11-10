import { Worker, type WorkerOptions } from 'node:worker_threads';

// This thread never runs SQLite: it can kill the containing OS process even
// while native SQLite blocks the query thread, including after host death.
const GUARD = `
const { parentPort, workerData } = require('node:worker_threads');
const die = () => process.kill(process.pid, 'SIGKILL');
setTimeout(die, Math.max(1, workerData.deadline - Date.now()));
const checkParent = () => {
  if (process.ppid !== workerData.parentPid) return die();
  try { process.kill(workerData.parentPid, 0); } catch (e) { if (e.code === 'ESRCH') die(); }
};
checkParent();
setInterval(checkParent, 50);
parentPort.postMessage('ready');
`;

export async function startDeepSearchGuard(parentPid: number, deadline: number,
  createWorker: (code: string, options: WorkerOptions) => Worker = (code, options) => new Worker(code, options),
): Promise<Worker> {
  const guard = createWorker(GUARD, { eval: true, workerData: {
    parentPid, deadline: Math.min(deadline + 250, Date.now() + 30_000),
  } });
  await new Promise<void>((resolve, reject) => {
    const earlyExit = () => reject(new Error('Deep search guard exited before readiness'));
    guard.once('exit', earlyExit);
    guard.once('message', () => { guard.off('exit', earlyExit); resolve(); });
    guard.once('error', reject);
  });
  return guard;
}
