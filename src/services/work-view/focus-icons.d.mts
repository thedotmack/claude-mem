export const FOCUS_ICONS_DIR: 'focus-icons';
export * from './focus-icon-limits.mjs';
import type { FocusIconFormat, FocusIconUploadFormat } from './focus-icon-limits.mjs';

export interface FocusIconFile { file: string; version: string; format: FocusIconFormat }

export function focusIconKey(focusAreaId: string): string;
export function sniffFocusIconUpload(bytes: Buffer): FocusIconUploadFormat | null;
export function readFocusIconIndex(ledgerDir: string | null): Map<string, FocusIconFile>;
export function readFocusIcon(ledgerDir: string, focusAreaId: string): (FocusIconFile & { path: string }) | null;
export function writeFocusIcon(ledgerDir: string, focusAreaId: string, format: FocusIconFormat, bytes: Buffer | string): string;
export function removeFocusIcon(ledgerDir: string, focusAreaId: string): boolean;
