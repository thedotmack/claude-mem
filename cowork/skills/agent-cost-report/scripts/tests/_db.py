"""A small claude-mem-shaped SQLite DB for tests: real table and column names (SessionStore.ts base DDL,
verified against the live DB with `.schema` on 2026-09-25), only the columns the rollup reads."""
import sqlite3

DDL = """
CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT NOT NULL, memory_session_id TEXT UNIQUE,
  project TEXT NOT NULL, platform_source TEXT NOT NULL DEFAULT 'claude', user_prompt TEXT, started_at TEXT NOT NULL,
  started_at_epoch INTEGER NOT NULL, completed_at TEXT, completed_at_epoch INTEGER,
  status TEXT CHECK(status IN ('active','completed','failed')) NOT NULL DEFAULT 'active', custom_title TEXT, observed_model TEXT, observed_billing TEXT);
CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT NOT NULL, project TEXT NOT NULL, type TEXT NOT NULL,
  title TEXT, discovery_tokens INTEGER DEFAULT 0, created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL, generated_by_model TEXT, origin_device_id TEXT);
CREATE TABLE session_summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT NOT NULL, project TEXT NOT NULL, request TEXT,
  completed TEXT, discovery_tokens INTEGER DEFAULT 0, created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL, origin_device_id TEXT);
CREATE TABLE user_prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT NOT NULL, prompt_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL, created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL, origin_device_id TEXT);
CREATE TABLE tool_uses (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_use_id TEXT NOT NULL, content_session_id TEXT NOT NULL, project TEXT NOT NULL,
  tool_name TEXT NOT NULL, created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL);
"""


def make_db(path):
    db = sqlite3.connect(path); db.executescript(DDL); db.commit(); return db


def add_session(db, cs, mid, project, started_ms, status="completed", completed_ms=None, user_prompt=None, platform="claude"):
    db.execute("insert into sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, "
               "completed_at, completed_at_epoch, status) values (?,?,?,?,?,?,?,?,?,?)",
               (cs, mid, project, platform, user_prompt, "x", started_ms, "x" if completed_ms else None, completed_ms, status))


def add_obs(db, mid, project, type_, title, tokens, ms, model="gemini-2.5-flash-lite", device=None):
    cur = db.execute("insert into observations (memory_session_id, project, type, title, discovery_tokens, created_at, created_at_epoch, generated_by_model, origin_device_id) "
                     "values (?,?,?,?,?,?,?,?,?)", (mid, project, type_, title, tokens, "x", ms, model, device))
    return cur.lastrowid


def add_summary(db, mid, project, request, completed, ms, tokens=0, device=None):
    db.execute("insert into session_summaries (memory_session_id, project, request, completed, discovery_tokens, created_at, created_at_epoch, origin_device_id) "
               "values (?,?,?,?,?,?,?,?)", (mid, project, request, completed, tokens, "x", ms, device))


def add_prompt(db, cs, n, text, ms, device=None):
    db.execute("insert into user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, origin_device_id) values (?,?,?,?,?,?)",
               (cs, n, text, "x", ms, device))


def add_tool(db, cs, project, ms, tid="t1"):
    db.execute("insert into tool_uses (tool_use_id, content_session_id, project, tool_name, created_at, created_at_epoch) values (?,?,?,?,?,?)",
               (tid, cs, project, "Bash", "x", ms))
