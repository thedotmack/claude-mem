import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { collectInstallStats } from '../../src/services/telemetry/install-stats';
import { ALLOWED_PROPERTY_KEYS } from '../../src/services/telemetry/scrub';

const DAY_MS = 86_400_000;

function makeDb(): Database {
  const db = new Database(':memory:');
  db.run(`
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL
    );
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
  `);
  return db;
}

describe('collectInstallStats', () => {
  it('reports counts, age, and activity windows', () => {
    const db = makeDb();
    const now = Date.now();
    const insertSession = db.prepare('INSERT INTO sdk_sessions (project, started_at_epoch) VALUES (?, ?)');
    insertSession.run('alpha', now - 100 * DAY_MS);
    insertSession.run('alpha', now - 5 * DAY_MS);
    insertSession.run('beta', now - 1 * DAY_MS);

    const insertObs = db.prepare('INSERT INTO observations (project, created_at_epoch) VALUES (?, ?)');
    insertObs.run('alpha', now - 40 * DAY_MS); // outside both windows
    insertObs.run('alpha', now - 20 * DAY_MS); // 30d only
    insertObs.run('beta', now - 2 * DAY_MS);   // 7d and 30d

    db.prepare('INSERT INTO session_summaries (project, created_at_epoch) VALUES (?, ?)').run('alpha', now);

    const stats = collectInstallStats(db);

    expect(stats.db_session_count).toBe(3);
    expect(stats.db_observation_count).toBe(3);
    expect(stats.db_summary_count).toBe(1);
    expect(stats.db_project_count).toBe(2);
    expect(stats.install_age_days).toBe(100);
    expect(stats.obs_count_7d).toBe(1);
    expect(stats.obs_count_30d).toBe(2);
    expect(stats.days_since_last_obs).toBe(2);
    // ':memory:' has no file to stat, so size is omitted rather than faked.
    expect(stats.db_size_mb).toBeUndefined();
  });

  it('normalizes legacy seconds-unit epochs before date math', () => {
    const db = makeDb();
    const now = Date.now();
    // Legacy rows were written in epoch seconds; this one is 50 days old.
    const legacySeconds = Math.floor((now - 50 * DAY_MS) / 1000);
    db.prepare('INSERT INTO sdk_sessions (project, started_at_epoch) VALUES (?, ?)').run('alpha', legacySeconds);
    db.prepare('INSERT INTO observations (project, created_at_epoch) VALUES (?, ?)').run('alpha', Math.floor((now - 1 * DAY_MS) / 1000));

    const stats = collectInstallStats(db);

    // Without normalization a seconds epoch reads as January 1970 and the
    // age inflates to ~20,000 days.
    expect(stats.install_age_days).toBe(50);
    expect(stats.days_since_last_obs).toBe(1);
    expect(stats.obs_count_7d).toBe(1);
  });

  it('returns empty stats rather than throwing when tables are missing', () => {
    const db = new Database(':memory:');
    const stats = collectInstallStats(db);
    expect(stats).toEqual({});
  });

  it('omits age/recency keys on an empty schema instead of sending zeros', () => {
    const db = makeDb();
    const stats = collectInstallStats(db);
    expect(stats.db_observation_count).toBe(0);
    expect(stats.db_project_count).toBe(0);
    expect(stats.install_age_days).toBeUndefined();
    expect(stats.days_since_last_obs).toBeUndefined();
  });

  it('only emits keys that survive the scrub whitelist', () => {
    const db = makeDb();
    db.prepare('INSERT INTO sdk_sessions (project, started_at_epoch) VALUES (?, ?)').run('alpha', Date.now());
    db.prepare('INSERT INTO observations (project, created_at_epoch) VALUES (?, ?)').run('alpha', Date.now());
    for (const key of Object.keys(collectInstallStats(db))) {
      expect(ALLOWED_PROPERTY_KEYS.has(key)).toBe(true);
    }
  });
});
