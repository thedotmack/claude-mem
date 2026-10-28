"""Map each session's tool calls to the observations claude-mem made of them, with the time each observation existed.

Usage: python3 prep_observations.py <your claude-mem data dir> <work dir> <sessions dir>

Reads your claude-mem database only through a copy made with sqlite's backup API (<work dir>/db/claude-mem-copy.db;
the live file is opened read only for the copy), and your worker logs (<data dir>/logs/claude-mem-*.log), read only.
Per session (content_session_id = the transcript's session id):
- tool_uses.tool_use_id -> observation_id gives the batch's first observation;
- the batch's other observations come from tool_use_batch_observations when your database has it, else from the
  worker log's `STORED | ... obsIds=[...]` line that stored the first one;
- an observation is taken to exist from the time of its STORED log line (worker logs are in this machine's local
  time); without one, from observations.created_at_epoch, which is the observed event's time and so earlier than
  storage (counted as `linked_created_at_only` and reported).
Calls with no observation stay raw, as the Endless Mode stage leaves them.
"""
import collections, datetime, glob, json, os, re, sqlite3, sys

STORED = re.compile(r'^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\] \[INFO \] \[DB\s*\] \[session-(\d+)\] STORED \| .*?obsCount=(\d+) \| obsIds=\[([\d, ]*)\]')

def local_to_epoch_ms(s):
    # A naive datetime's timestamp() is read in this machine's local time zone, DST included.
    return int(datetime.datetime.strptime(s, '%Y-%m-%d %H:%M:%S.%f').timestamp() * 1000)

def stored_log(data_dir):
    out = {}
    files = sorted(glob.glob(os.path.join(data_dir, 'logs', 'claude-mem-*.log')))
    for f in files:
        for line in open(f, errors='replace'):
            if 'STORED' not in line: continue
            m = STORED.match(line)
            if not m: continue
            ids = [int(x) for x in m.group(4).replace(' ', '').split(',') if x]
            for i in ids: out.setdefault(i, {'stored_local': m.group(1), 'batch': ids})
    return out, len(files)

def backup_copy(data_dir, work_dir):
    src = os.path.join(data_dir, 'claude-mem.db')
    if not os.path.exists(src): sys.exit(f'no claude-mem database at {src}')
    os.makedirs(os.path.join(work_dir, 'db'), exist_ok=True)
    dst = os.path.join(work_dir, 'db', 'claude-mem-copy.db')
    if not os.path.exists(dst):
        live = sqlite3.connect(f'file:{src}?mode=ro', uri=True); copy = sqlite3.connect(dst)
        live.backup(copy); copy.close(); live.close()
    return dst

def main(data_dir, work_dir, sessions_dir):
    db = sqlite3.connect(f'file:{backup_copy(data_dir, work_dir)}?mode=ro', uri=True); db.row_factory = sqlite3.Row
    has_batch_table = db.execute("select 1 from sqlite_master where type='table' and name='tool_use_batch_observations'").fetchone() is not None
    stored, n_logs = stored_log(data_dir)
    print(f'{len(stored)} observations with a STORED log line in {n_logs} log files; batch table {"present" if has_batch_table else "absent"}', flush=True)
    summary = {}
    for d in sorted(glob.glob(os.path.join(sessions_dir, '*', 'session.json'))):
        sdir = os.path.dirname(d); sid = json.load(open(d))['meta']['session_id']
        tus = db.execute('select tool_use_id, observation_id from tool_uses where content_session_id=?', (sid,)).fetchall()
        batch_rows = collections.defaultdict(list)
        if has_batch_table:
            for row in db.execute('select tool_use_id, observation_id from tool_use_batch_observations where content_session_id=?', (sid,)):
                batch_rows[row['tool_use_id']].append(row['observation_id'])
        out = {}; c = collections.Counter(); lag = []; cache = {}
        def obs(i):
            if i not in cache:
                cache[i] = db.execute('select id, type, title, subtitle, narrative, facts, files_read, files_modified, created_at_epoch from observations where id=?', (i,)).fetchone()
            return cache[i]
        for t in tus:
            c['tool_uses'] += 1
            if t['observation_id'] is None: c['no_observation'] += 1; continue
            first = t['observation_id']; log = stored.get(first)
            batch = sorted(set(batch_rows.get(t['tool_use_id']) or [])) or (log['batch'] if log else [first])
            rows = []
            for oid in batch:
                o = obs(oid)
                if o is None: c['batch_obs_missing_in_db'] += 1; continue
                ol = stored.get(oid) or log
                avail = local_to_epoch_ms(ol['stored_local']) if ol else o['created_at_epoch']
                rows.append(dict(observation_id=o['id'], type=o['type'], title=o['title'], subtitle=o['subtitle'], narrative=o['narrative'], facts=o['facts'],
                                 files_read=o['files_read'], files_modified=o['files_modified'], created_at_epoch=o['created_at_epoch'],
                                 available_at_ms=avail, timing='stored-log' if ol else 'created_at (event time)'))
            if not rows: continue
            if log: c['linked_with_log_time'] += 1; lag.append((local_to_epoch_ms(log['stored_local']) - obs(first)['created_at_epoch']) / 1000)
            else: c['linked_created_at_only'] += 1
            c['batch_rows'] += len(rows); out[t['tool_use_id']] = rows
        json.dump(out, open(os.path.join(sdir, 'observations.json'), 'w'), ensure_ascii=False)
        lag.sort()
        summary[os.path.basename(sdir)] = dict(counts=dict(c), store_lag_seconds_median=(lag[len(lag) // 2] if lag else None),
                                               store_lag_seconds_p90=(lag[int(len(lag) * 0.9)] if lag else None))
        print(os.path.basename(sdir), dict(c), flush=True)
    json.dump(summary, open(os.path.join(sessions_dir, 'observations-summary.json'), 'w'), indent=1)

if __name__ == '__main__':
    main(*sys.argv[1:4])
