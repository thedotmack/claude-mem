const FRAME_WIDTH = 36;
const FRAME_HEIGHT = 16;
const RAY_COUNT = 12;
const CENTER_RADIUS = 1.2;
const MAX_RAY_RADIUS = 7.0;
const CHAR_ASPECT = 2.0;
const TWIST = 0.10;

const ORANGE = '\x1b[38;2;231;111;81m';
const DIM = '\x1b[38;2;180;80;55m';
const FAINT = '\x1b[2m';
const RESET = '\x1b[0m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

const WORDMARK = 'claude-mem';
const TAGLINE = 'persistent memory across sessions';

function moveUp(n: number): string {
  return n > 0 ? `\x1b[${n}A` : '';
}
function clearLine(): string {
  return '\x1b[2K';
}

function renderLogo(growth: number): string[] {
  const cx = FRAME_WIDTH / 2;
  const cy = FRAME_HEIGHT / 2;
  const grid: string[][] = Array.from({ length: FRAME_HEIGHT }, () => Array(FRAME_WIDTH).fill(' '));
  const styles: string[][] = Array.from({ length: FRAME_HEIGHT }, () => Array(FRAME_WIDTH).fill(''));
  const intensities: number[][] = Array.from({ length: FRAME_HEIGHT }, () => Array(FRAME_WIDTH).fill(0));

  for (let y = 0; y < FRAME_HEIGHT; y++) {
    for (let x = 0; x < FRAME_WIDTH; x++) {
      const dx = (x - cx) / CHAR_ASPECT;
      const dy = y - cy;
      if (Math.sqrt(dx * dx + dy * dy) < CENTER_RADIUS) {
        grid[y][x] = '#';
        styles[y][x] = ORANGE;
        intensities[y][x] = 1;
      }
    }
  }

  const reach = CENTER_RADIUS + (MAX_RAY_RADIUS - CENTER_RADIUS) * growth;
  for (let i = 0; i < RAY_COUNT; i++) {
    const baseAngle = (i / RAY_COUNT) * Math.PI * 2;
    for (let r = CENTER_RADIUS; r <= reach; r += 0.4) {
      const angle = baseAngle + TWIST * (r - CENTER_RADIUS);
      const x = cx + Math.cos(angle) * r * CHAR_ASPECT;
      const y = cy + Math.sin(angle) * r;
      const ix = Math.round(x);
      const iy = Math.round(y);
      if (ix < 0 || ix >= FRAME_WIDTH || iy < 0 || iy >= FRAME_HEIGHT) continue;

      const baseT = (r - CENTER_RADIUS) / (MAX_RAY_RADIUS - CENTER_RADIUS);
      const tipFade = Math.min(1, (reach - r) / 0.8);
      const intensity = (1 - baseT * 0.5) * tipFade;

      if (intensity > intensities[iy][ix]) {
        intensities[iy][ix] = intensity;
        grid[iy][ix] = intensity > 0.7 ? '#' : intensity > 0.4 ? '*' : intensity > 0.2 ? '+' : '.';
        styles[iy][ix] = intensity > 0.5 ? ORANGE : DIM;
      }
    }
  }

  return grid.map((row, y) => {
    let out = '';
    let lastStyle = '';
    for (let x = 0; x < FRAME_WIDTH; x++) {
      const style = styles[y][x];
      if (style !== lastStyle) {
        out += style || RESET;
        lastStyle = style;
      }
      out += row[x];
    }
    return out + RESET;
  });
}

function compose(growth: number, wordmarkProgress: number): string[] {
  const lines = renderLogo(growth);
  const midY = Math.floor(FRAME_HEIGHT / 2);
  const padLeft = '   ';

  if (wordmarkProgress > 0) {
    const charsToShow = Math.ceil(WORDMARK.length * wordmarkProgress);
    const visible = WORDMARK.slice(0, charsToShow);
    lines[midY - 1] += padLeft + ORANGE + visible + RESET;
  }
  if (wordmarkProgress >= 1) {
    const charsToShow = Math.ceil(TAGLINE.length * Math.min(1, (wordmarkProgress - 1) * 2.5 + 0.001));
    const visible = TAGLINE.slice(0, charsToShow);
    lines[midY] += padLeft + FAINT + visible + RESET;
  }
  return lines;
}

export function isBannerEnabled(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env.CI) return false;
  if (process.env.CLAUDE_MEM_NO_BANNER) return false;
  if (process.env.NO_COLOR) return false;
  const cols = process.stdout.columns ?? 80;
  if (cols < FRAME_WIDTH + TAGLINE.length + 6) return false;
  return true;
}

export async function playBanner(): Promise<void> {
  if (!isBannerEnabled()) return;

  const stdout = process.stdout;
  const bloomFrames = 14;
  const wordmarkFrames = 10;
  const totalFrames = bloomFrames + wordmarkFrames;
  const frameMs = 38;
  let firstFrame = true;

  stdout.write(HIDE_CURSOR);
  try {
    for (let i = 0; i <= totalFrames; i++) {
      const growth = Math.min(1, i / bloomFrames);
      const wordmarkProgress = i <= bloomFrames ? 0 : ((i - bloomFrames) / wordmarkFrames) * 1.4;
      const lines = compose(growth, wordmarkProgress);

      if (firstFrame) {
        stdout.write(lines.join('\n') + '\n');
        firstFrame = false;
      } else {
        stdout.write(moveUp(FRAME_HEIGHT));
        for (let l = 0; l < FRAME_HEIGHT; l++) {
          stdout.write('\r' + clearLine() + lines[l] + '\n');
        }
      }

      await new Promise((resolve) => setTimeout(resolve, frameMs));
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  } finally {
    stdout.write(SHOW_CURSOR);
  }
}
