// SPDX-License-Identifier: Apache-2.0
//
// `claude-mem wire run` starts an interactive agent through up to two
// claude-mem processes (npx CLI → wire gateway script), each with inherited
// stdio. Both must outlive the agent:
//
// - Ctrl-C reaches the whole foreground process group, so the agent already
//   has it (an agent uses it to cancel a turn). A parent that died of it would
//   hand the terminal back to the shell while the agent still runs on it, and
//   lose the agent's exit code. So SIGINT is ignored here while the child runs.
// - SIGTERM and SIGHUP sent to this process alone are passed on to the child,
//   which decides how to end; this process exits with its code afterwards.

import type { ChildProcess } from 'child_process';

const RELAYED_SIGNALS = ['SIGTERM', 'SIGHUP'] as const;

/** Keep this process alive for its interactive child. Returns the function that removes the handlers. */
export function relaySignalsToInteractiveChild(child: ChildProcess): () => void {
  const ignoreInterrupt = () => undefined;
  const relays = RELAYED_SIGNALS.map((signal) => {
    const relay = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    process.on(signal, relay);
    return { signal, relay };
  });
  process.on('SIGINT', ignoreInterrupt);
  return () => {
    process.off('SIGINT', ignoreInterrupt);
    for (const { signal, relay } of relays) process.off(signal, relay);
  };
}
