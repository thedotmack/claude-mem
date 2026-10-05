export function expandHome(filePath: string, platform?: NodeJS.Platform, home?: string): string;
export function classifySettingsDocument(document: Record<string, unknown>): 'flat' | 'nested';
export function settingsTarget(document: Record<string, unknown>): Record<string, unknown>;
export function stripUtf8Bom(raw: string): string;
export function parseJsonWithBom<T = unknown>(raw: string): T;
export function readJsonFileWithBom<T = unknown>(filepath: string): T;
export function resolveDataDir(): string;
