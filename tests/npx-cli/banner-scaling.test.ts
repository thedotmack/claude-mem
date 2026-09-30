import { describe, it, expect } from 'bun:test';
import {
  parseFrameCells,
  downsampleFrameCells,
  renderFrameCells,
  scaleFrame,
  type FrameCell,
} from '../../src/npx-cli/banner';

// Synthetic 8x4 frame. Row 1 has an accent span over "kl"; row 3 has an
// accent span over "yz01" that starts mid-row.
const SYNTHETIC_FRAME = [
  'abcdefgh',
  'ij<x>kl</x>mnop',
  'qrstuvwx',
  '<x>yz01</x>2345',
].join('\n');

const plain = (rows: FrameCell[][]): string[] => rows.map((r) => r.map((c) => c.ch).join(''));

describe('banner frame scaling', () => {
  describe('parseFrameCells', () => {
    it('parses rows and columns, stripping span markers', () => {
      const cells = parseFrameCells(SYNTHETIC_FRAME);
      expect(cells.length).toBe(4);
      expect(cells.every((row) => row.length === 8)).toBe(true);
      expect(plain(cells)).toEqual(['abcdefgh', 'ijklmnop', 'qrstuvwx', 'yz012345']);
    });

    it('flags accent cells inside span markers only', () => {
      const cells = parseFrameCells(SYNTHETIC_FRAME);
      expect(cells[0].map((c) => c.accent)).toEqual([false, false, false, false, false, false, false, false]);
      expect(cells[1].map((c) => c.accent)).toEqual([false, false, true, true, false, false, false, false]);
      expect(cells[3].map((c) => c.accent)).toEqual([true, true, true, true, false, false, false, false]);
    });
  });

  describe('downsampleFrameCells', () => {
    it('picks evenly-sampled columns (nearest neighbor)', () => {
      const cells = parseFrameCells(SYNTHETIC_FRAME);
      const scaled = downsampleFrameCells(cells, 4, 4);
      // 8 -> 4 columns: source indices floor(j * 8 / 4) = 0, 2, 4, 6
      expect(plain(scaled)).toEqual(['aceg', 'ikmo', 'qsuw', 'y024']);
    });

    it('picks evenly-sampled rows (nearest neighbor)', () => {
      const cells = parseFrameCells(SYNTHETIC_FRAME);
      const scaled = downsampleFrameCells(cells, 8, 2);
      // 4 -> 2 rows: source indices floor(r * 4 / 2) = 0, 2
      expect(plain(scaled)).toEqual(['abcdefgh', 'qrstuvwx']);
    });

    it('preserves accent flags through downsampling', () => {
      const cells = parseFrameCells(SYNTHETIC_FRAME);
      const scaled = downsampleFrameCells(cells, 4, 4);
      // Row 1 sampled cols 0,2,4,6 -> chars i,k,m,o; only 'k' (col 2) is accented.
      expect(scaled[1].map((c) => c.accent)).toEqual([false, true, false, false]);
      // Row 3 sampled cols 0,2,4,6 -> y,0,2,4; 'y' and '0' are accented.
      expect(scaled[3].map((c) => c.accent)).toEqual([true, true, false, false]);
    });

    it('never upsamples beyond the source grid', () => {
      const cells = parseFrameCells(SYNTHETIC_FRAME);
      const scaled = downsampleFrameCells(cells, 999, 999);
      expect(plain(scaled)).toEqual(plain(cells));
    });
  });

  describe('renderFrameCells', () => {
    it('monochrome output contains no SGR color codes at all', () => {
      const cells = parseFrameCells(SYNTHETIC_FRAME);
      const out = renderFrameCells(cells, { color: false, truecolor: true });
      expect(out).not.toContain('\x1b[3');
      expect(out).not.toContain('\x1b');
      expect(out).toBe('abcdefgh\nijklmnop\nqrstuvwx\nyz012345');
    });

    it('colored output switches to accent color on accent cells and resets', () => {
      const cells = parseFrameCells(SYNTHETIC_FRAME);
      const out = renderFrameCells(cells, { color: true, truecolor: false });
      expect(out.startsWith('\x1b[38;5;208m')).toBe(true);
      expect(out).toContain('\x1b[38;5;215mkl\x1b[38;5;208m');
      expect(out.endsWith('\x1b[0m')).toBe(true);
    });
  });

  describe('scaleFrame', () => {
    it('composes parse + downsample + render', () => {
      const out = scaleFrame(SYNTHETIC_FRAME, 4, 2, { color: false, truecolor: false });
      expect(out).toBe('aceg\nqsuw');
      expect(out).not.toContain('\x1b[3');
    });
  });
});
