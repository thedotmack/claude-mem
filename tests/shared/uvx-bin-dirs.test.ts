import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { getUvxBinDirs } from '../../src/shared/uvx-bin-dirs.js';

const HOME = '/home/tester';
const opts = (env: Record<string, string | undefined>) => ({
  homedir: () => HOME,
  platform: 'linux' as NodeJS.Platform,
  isFile: () => false,
  env,
});

describe('getUvxBinDirs installer env-var honouring', () => {
  it('always includes the default ~/.local/bin and ~/.cargo/bin', () => {
    const dirs = getUvxBinDirs(opts({}));
    expect(dirs).toContain(join(HOME, '.local', 'bin'));
    expect(dirs).toContain(join(HOME, '.cargo', 'bin'));
  });

  it('honours UV_INSTALL_DIR', () => {
    const dirs = getUvxBinDirs(opts({ UV_INSTALL_DIR: '/opt/uv/bin' }));
    expect(dirs).toContain('/opt/uv/bin');
  });

  it('honours XDG_BIN_HOME', () => {
    const dirs = getUvxBinDirs(opts({ XDG_BIN_HOME: '/home/tester/.xdgbin' }));
    expect(dirs).toContain('/home/tester/.xdgbin');
  });

  it('appends ../bin to XDG_DATA_HOME', () => {
    const dirs = getUvxBinDirs(opts({ XDG_DATA_HOME: '/home/tester/.xdgdata' }));
    expect(dirs).toContain(join('/home/tester/.xdgdata', '..', 'bin'));
  });

  it('honours the CLAUDE_MEM_CHROMA_UVX_PATH override', () => {
    const dirs = getUvxBinDirs(opts({ CLAUDE_MEM_CHROMA_UVX_PATH: '/custom/bin' }));
    expect(dirs).toContain('/custom/bin');
  });

  it('deduplicates repeated dirs', () => {
    const dirs = getUvxBinDirs(opts({ UV_INSTALL_DIR: join(HOME, '.local', 'bin') }));
    expect(dirs.filter(d => d === join(HOME, '.local', 'bin')).length).toBe(1);
  });
});
