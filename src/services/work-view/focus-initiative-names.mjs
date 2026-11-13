// An initiative's name: the heading the owner files focus areas under ("Kite app", "Small experiments").
// For the worker that saves one and the page that edits one. No Node imports: My Work loads this file.

/** A heading, not a sentence. */
export const MAX_FOCUS_INITIATIVE_CHARS = 60;

/** Two names are one initiative when these are equal: "Kite App" and " kite app". */
export const initiativeKey = (name) => typeof name === 'string' ? name.trim().toLowerCase() : '';
