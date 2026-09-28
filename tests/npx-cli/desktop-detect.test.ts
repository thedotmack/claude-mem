import { describe, expect, it } from 'bun:test';
import { isDesktopSession, isWsl } from '../../src/npx-cli/install/desktop-detect';

type Row = [NodeJS.Platform, Record<string, string>, boolean, string];

const rows: Row[] = [
  ['darwin', {}, true, 'macOS'],
  ['win32', {}, true, 'Windows'],
  ['linux', { DISPLAY: ':0' }, true, 'Linux X11'],
  ['linux', { WAYLAND_DISPLAY: 'wayland-0' }, true, 'Linux Wayland'],
  ['linux', {}, false, 'headless Linux'],
  ['darwin', { CI: '1' }, false, 'CI on macOS'],
  ['win32', { CI: 'true' }, false, 'CI on Windows'],
  ['linux', { DISPLAY: ':0', CI: '1' }, false, 'CI with a display'],
  ['darwin', { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' }, false, 'SSH into a Mac'],
  ['linux', { DISPLAY: 'localhost:10.0', SSH_TTY: '/dev/pts/0' }, false, 'SSH with X forwarding'],
  ['win32', { SSH_TTY: '/dev/pts/1' }, false, 'SSH into Windows'],
  ['linux', { DISPLAY: ':0', WSL_DISTRO_NAME: 'Ubuntu' }, false, 'WSL with WSLg display'],
  ['linux', { WAYLAND_DISPLAY: 'wayland-0', WSL_INTEROP: '/run/WSL/1_interop' }, false, 'WSL interop'],
  ['freebsd', { DISPLAY: ':0' }, false, 'unsupported platform'],
];

describe('isDesktopSession', () => {
  for (const [platform, env, expected, label] of rows) {
    it(`${label} -> ${expected}`, () => {
      expect(isDesktopSession(platform, env)).toBe(expected);
    });
  }

  it('flags WSL only on linux', () => {
    expect(isWsl('linux', { WSL_DISTRO_NAME: 'Ubuntu' })).toBe(true);
    expect(isWsl('win32', { WSL_DISTRO_NAME: 'Ubuntu' })).toBe(false);
    expect(isWsl('linux', {})).toBe(false);
  });
});
