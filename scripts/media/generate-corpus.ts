/**
 * Rebuild public test art locally; no provider requests and no private inputs.
 * SVG is a fixture-authoring source only, not an accepted converter input.
 * Sharp buffer/output APIs: https://sharp.pixelplumbing.com/api-output/
 */
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { EvaluationFixture, EvaluationImage } from './evaluation.js';

const root = new URL('../../tests/fixtures/media-v1/corpus/', import.meta.url);
const fixtures: EvaluationFixture[] = [];
const svg = (body: string, width = 960, height = 640, background = '#f8fafc') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${background}"/><g font-family="DejaVu Sans,Arial,sans-serif" fill="#17212b">${body}</g></svg>`;
const text = (x: number, y: number, content: string, size = 24, fill = '#17212b') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}">${content}</text>`;

async function image(file: string, body: string, label = 'event1_image1'): Promise<EvaluationImage> {
  const bytes = await sharp(Buffer.from(body)).png().toBuffer();
  await writeFile(new URL(file, root), bytes);
  const { width, height } = await sharp(bytes).metadata();
  return { file, sha256: createHash('sha256').update(bytes).digest('hex'), width: width!, height: height!, label };
}

async function main(): Promise<void> {
  await mkdir(root, { recursive: true });
  const screenshot = await image('screenshot-small-text.png', svg(
    text(40, 56, 'Build dashboard', 28) +
    '<rect x="40" y="85" width="880" height="480" rx="8" fill="#ffffff" stroke="#cbd5e1"/>' +
    text(64, 122, 'release-widget / run 2048', 14) + text(64, 158, 'Result: FAILED', 14, '#b91c1c') +
    text(64, 191, 'Reason: migration 0064 checksum mismatch', 12) +
    text(64, 224, 'Retry after reviewing the applied migration', 12) +
    text(64, 300, 'Passed: 128   Failed: 1   Skipped: 0', 12)));
  fixtures.push({ id: 'screenshot-small-text', kind: 'screenshot', recipe: 'screenshot-v1', images: [screenshot], expected_observations: [{ image_labels: [screenshot.label], facts: ['Result: FAILED', 'migration 0064 checksum mismatch', 'Passed: 128; Failed: 1; Skipped: 0'] }] });

  const terminal = await image('terminal-error.png', svg(
    text(32, 50, '$ npm run build', 22, '#a7f3d0') + text(32, 98, 'src/auth/token.ts:42:7', 18, '#dbeafe') +
    text(32, 137, 'error TS2322: Type string is not assignable to type number', 18, '#fca5a5') +
    text(32, 194, 'Build failed with exit code 2', 20, '#fca5a5'), 1100, 500, '#111827'));
  fixtures.push({ id: 'terminal-error', kind: 'terminal', recipe: 'screenshot-v1', images: [terminal], expected_observations: [{ image_labels: [terminal.label], facts: ['TS2322 at src/auth/token.ts:42:7', 'string is not assignable to number', 'exit code 2'] }] });

  const chart = await image('chart.png', svg(
    text(40, 55, 'Requests by outcome') + '<line x1="110" y1="500" x2="820" y2="500" stroke="#334155"/>' +
    '<rect x="175" y="140" width="140" height="360" fill="#2563eb"/><rect x="455" y="410" width="140" height="90" fill="#d97706"/>' +
    text(205, 120, '80') + text(490, 390, '20') + text(190, 545, 'Success', 20) + text(470, 545, 'Failure', 20) + text(40, 600, 'Count, not latency', 14)));
  fixtures.push({ id: 'chart', kind: 'chart', recipe: 'screenshot-v1', images: [chart], expected_observations: [{ image_labels: [chart.label], facts: ['Success: 80', 'Failure: 20', 'chart measures counts'] }] });

  const diagram = await image('diagram.png', svg(
    text(40, 55, 'Private media pipeline') + '<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#334155"/></marker></defs>' +
    '<rect x="55" y="240" width="220" height="90" fill="#dbeafe"/><rect x="365" y="240" width="220" height="90" fill="#dcfce7"/><rect x="675" y="240" width="230" height="90" fill="#ffedd5"/>' +
    '<line x1="278" y1="285" x2="358" y2="285" stroke="#334155" stroke-width="3" marker-end="url(#arrow)"/><line x1="588" y1="285" x2="668" y2="285" stroke="#334155" stroke-width="3" marker-end="url(#arrow)"/>' +
    text(90, 294, 'Capture', 22) + text(395, 294, 'Convert', 22) + text(695, 294, 'Private store', 22) + text(365, 400, 'No public URL', 18)));
  fixtures.push({ id: 'diagram', kind: 'diagram', recipe: 'screenshot-v1', images: [diagram], expected_observations: [{ image_labels: [diagram.label], facts: ['Capture -> Convert -> Private store', 'No public URL'] }] });

  const generated = await image('generated-art.png', svg(
    '<defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#172554"/><stop offset="1" stop-color="#f97316"/></linearGradient></defs>' +
    '<rect width="960" height="640" fill="url(#sky)"/><circle cx="745" cy="135" r="58" fill="#fde68a"/><path d="M0,620 L275,220 L510,620 Z" fill="#a5b4fc"/><path d="M340,640 L640,305 L960,640 Z" fill="#475569"/><path d="M205,320 L275,220 L343,335 L270,300 Z" fill="#fff"/>' + text(40, 70, 'Synthetic mountain study', 20, '#fff')));
  fixtures.push({ id: 'generated-image', kind: 'generated-image', recipe: 'photo-v1', images: [generated], expected_observations: [{ image_labels: [generated.label], facts: ['two triangular mountains', 'yellow circular sun at upper right', 'left mountain has a white peak'] }] });

  // Attribution and the exact upstream asset/hash are stored next to this file.
  const photoFile = 'nasa-apollo17-blue-marble.jpg';
  const photoBytes = await readFile(new URL(photoFile, root));
  const metadata = await sharp(photoBytes).metadata();
  const photo: EvaluationImage = { file: photoFile, sha256: createHash('sha256').update(photoBytes).digest('hex'), width: metadata.width!, height: metadata.height!, label: 'event1_image1' };
  fixtures.push({ id: 'photograph', kind: 'photograph', recipe: 'photo-v1', images: [photo], expected_observations: [{ image_labels: [photo.label], facts: ['Earth against black space', 'Africa is visible near the center', 'white cloud bands cross the southern hemisphere'] }] });

  const dark = await image('dark-ui.png', svg(
    text(42, 52, 'Storage operations', 26, '#e2e8f0') + '<rect x="40" y="90" width="880" height="120" fill="#1e293b"/>' +
    text(65, 135, 'Cleanup backlog', 16, '#94a3b8') + text(65, 183, '17 objects pending deletion', 22, '#fbbf24') +
    '<rect x="40" y="245" width="880" height="220" fill="#1e293b"/>' + text(65, 290, 'Owner quota', 16, '#94a3b8') +
    text(65, 342, '64 MiB / 256 MiB', 22, '#e2e8f0') + text(65, 409, 'Inference: DISABLED', 20, '#fca5a5'), 960, 640, '#0f172a'));
  fixtures.push({ id: 'dark-ui', kind: 'dark-ui', recipe: 'screenshot-v1', images: [dark], expected_observations: [{ image_labels: [dark.label], facts: ['17 objects pending deletion', '64 MiB / 256 MiB quota', 'Inference: DISABLED'] }] });

  const first = await image('two-image-before.png', svg(text(40, 65, 'BEFORE') + '<rect x="180" y="160" width="420" height="220" fill="#dc2626"/>' + text(210, 285, 'HTTP 500', 42, '#fff'), 800, 500), 'event1_image1');
  const second = await image('two-image-after.png', svg(text(40, 65, 'AFTER') + '<rect x="180" y="160" width="420" height="220" fill="#15803d"/>' + text(210, 285, 'HTTP 200', 42, '#fff'), 800, 500), 'event1_image2');
  fixtures.push({ id: 'two-image-event', kind: 'two-image-event', recipe: 'screenshot-v1', images: [first, second], expected_observations: [
    { image_labels: [first.label], facts: ['BEFORE: HTTP 500', 'red status card'] },
    { image_labels: [second.label], facts: ['AFTER: HTTP 200', 'green status card'] },
  ] });

  await writeFile(new URL('manifest.json', root), JSON.stringify({ version: 1, origin: 'public-generated-and-nasa', generator: 'scripts/media/generate-corpus.ts', encoder: sharp.versions, fixtures }, null, 2) + '\n');
  console.log(`Generated ${fixtures.length} public evaluation cases / ${fixtures.reduce((sum, fixture) => sum + fixture.images.length, 0)} images; zero provider calls`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
