// What a focus icon may be, for the worker that stores it and the page that draws an upload. No Node imports: My Work loads this file.

/** What an icon file is, by its extension. An upload is stored as webp or png; svg comes only from the checked generator answer. */
export const FOCUS_ICON_CONTENT_TYPES = Object.freeze({ webp: 'image/webp', png: 'image/png', svg: 'image/svg+xml' });
/** The formats the page may upload. */
export const FOCUS_ICON_UPLOAD_FORMATS = Object.freeze(['webp', 'png']);
export const MAX_FOCUS_ICON_UPLOAD_BYTES = 200_000;
export const MAX_FOCUS_ICON_SVG_BYTES = 20_000;
/** The owner's own direction for a generated icon ("a paper airplane, warm colors"): one line. */
export const MAX_FOCUS_ICON_DIRECTION_CHARS = 300;
