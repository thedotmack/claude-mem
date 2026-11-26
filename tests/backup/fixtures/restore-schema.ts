/** Minimal unstamped worker schema for file-swap tests that store notes. */
export const RESTORE_FIXTURE_SCHEMA = `
  CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY);
  CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL);
  CREATE TABLE session_summaries (id INTEGER PRIMARY KEY);
`;
