import { playBanner } from './banner.js';

Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
process.stdout.columns = process.stdout.columns ?? 140;
process.stdout.rows = process.stdout.rows ?? 50;
process.env.COLORTERM = process.env.COLORTERM ?? 'truecolor';
playBanner().then(() => process.exit(0));
