/**
 * Tmux pane management for cmem stream sidebar.
 * Opens a vertical split running "cmem stream --inline".
 */

import { execSync } from 'child_process';
import { isInTmux } from '../utils/detect.js';
import { CLIError, ExitCode } from '../errors.js';

const SIDEBAR_TITLE = 'cmem-stream';

/**
 * Check whether a cmem-stream pane is already open in the current tmux window.
 */
function sidebarAlreadyOpen(): boolean {
  try {
    const output = execSync(
      "tmux list-panes -F '#{pane_title}'",
      { stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString();
    return output.split('\n').some((line) => line.trim() === SIDEBAR_TITLE);
  } catch {
    return false;
  }
}

export interface SidebarOptions {
  width?: string;
}

/**
 * Open a tmux sidebar pane running "cmem stream --inline".
 * Throws CLIError if not inside a tmux session or pane is already open.
 */
export function openSidebar(options: SidebarOptions): void {
  if (!isInTmux()) {
    throw new CLIError(
      'Not inside a tmux session. Run "cmem stream" for inline output.',
      ExitCode.VALIDATION_ERROR,
      'Start a tmux session first: tmux new-session',
    );
  }

  if (sidebarAlreadyOpen()) {
    throw new CLIError(
      'cmem stream sidebar is already open in this tmux window.',
      ExitCode.VALIDATION_ERROR,
      'Kill the existing pane first, or switch to it.',
    );
  }

  const width = options.width ?? '35%';

  // Set pane title then launch stream inline
  // The title is set via the shell prompt inside the new pane using printf
  const cmd = [
    'tmux split-window',
    '-h',
    `-l ${width}`,
    `"printf '\\033]2;${SIDEBAR_TITLE}\\033\\\\\\\\' && cmem stream --inline"`,
  ].join(' ');

  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (err) {
    throw new CLIError(
      `Failed to open tmux sidebar: ${(err as Error).message}`,
      ExitCode.INTERNAL_ERROR,
      'Ensure tmux is installed and you are inside an active session.',
    );
  }
}
