export const FOCUS_ICON_CONTENT_TYPES: Readonly<{ webp: 'image/webp'; png: 'image/png'; svg: 'image/svg+xml' }>;
export type FocusIconFormat = keyof typeof FOCUS_ICON_CONTENT_TYPES;
export const FOCUS_ICON_UPLOAD_FORMATS: readonly ['webp', 'png'];
export type FocusIconUploadFormat = (typeof FOCUS_ICON_UPLOAD_FORMATS)[number];
export const MAX_FOCUS_ICON_UPLOAD_BYTES: number;
export const MAX_FOCUS_ICON_SVG_BYTES: number;
export const MAX_FOCUS_ICON_DIRECTION_CHARS: number;
