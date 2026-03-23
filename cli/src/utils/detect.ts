/**
 * Environment detection utilities.
 */

export function isTTY(): boolean {
  return !!process.stdout.isTTY;
}

export function terminalWidth(): number {
  return process.stdout.columns || 80;
}

export function isInTmux(): boolean {
  return !!process.env.TMUX;
}

export function isCI(): boolean {
  return !!process.env.CI;
}
