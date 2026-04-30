import { playBanner } from './banner.js';

const TIERS = [
  { cols: 100, rows: 30, label: 'small' },
  { cols: 140, rows: 40, label: 'medium' },
  { cols: 180, rows: 50, label: 'hero' },
];

const tier = process.argv[2] ?? 'small';
const t = TIERS.find(x => x.label === tier) ?? TIERS[0];
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
process.stdout.columns = t.cols;
process.stdout.rows = t.rows;
console.log(`--- Preview: ${t.label} tier (${t.cols}×${t.rows}) ---`);
playBanner().then(() => process.exit(0));
