"""Pick the sessions to backtest from your Claude Code transcripts (read only).

Scans <Claude config dir>/projects/*/*.jsonl and counts each session's main-thread API requests (unique assistant
message ids with usage) and compactions. Selected: the TOP longest by request count with activity in the last DAYS
days, plus (with --with-compactions) every session in that window with a Claude Code compaction.
Usage: python3 scan_sessions.py <claude config dir> <out selected.json> --top N --days D [--with-compactions] [--min-requests M]
Writes the selection and prints one line per selected session (request count, compactions, dates; no content).
"""
import argparse, collections, datetime, glob, json, os, sys

ap = argparse.ArgumentParser()
ap.add_argument('claude_dir'); ap.add_argument('out')
ap.add_argument('--top', type=int, required=True); ap.add_argument('--days', type=int, required=True)
ap.add_argument('--with-compactions', action='store_true')
ap.add_argument('--min-requests', type=int, default=1)
a = ap.parse_args()
cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=a.days)).strftime('%Y-%m-%dT%H:%M:%S')
cutoff_mtime = (datetime.datetime.now() - datetime.timedelta(days=a.days)).timestamp()
found = []
for path in glob.glob(os.path.join(a.claude_dir, 'projects', '*', '*.jsonl')):
    if os.path.getmtime(path) < cutoff_mtime: continue
    ids = set(); compactions = 0; first = last = None; models = collections.Counter()
    for line in open(path, errors='replace'):
        try: d = json.loads(line)
        except Exception: continue
        if d.get('isSidechain'): continue
        if d.get('type') == 'system' and d.get('subtype') == 'compact_boundary': compactions += 1
        if d.get('type') == 'assistant':
            m = d.get('message') or {}
            if m.get('model') == '<synthetic>' or not m.get('usage'): continue
            ids.add(m.get('id')); models[m.get('model')] += 1
            ts = d.get('timestamp')
            if ts: first = first or ts; last = ts
    if len(ids) < a.min_requests or not last or last < cutoff: continue
    found.append(dict(path=path, requests=len(ids), compactions=compactions, first=first, last=last, models=dict(models)))
found.sort(key=lambda r: -r['requests'])
selected = found[:a.top]
if a.with_compactions:
    selected += [r for r in found[a.top:] if r['compactions']]
non_claude = [r for r in selected if not any(str(m).startswith('claude') for m in r['models'])]
json.dump(selected, open(a.out, 'w'), indent=1)
print(f'{len(found)} sessions in the last {a.days} days; selected {len(selected)}' + (f' ({len(non_claude)} with no claude-* model)' if non_claude else ''))
for k, r in enumerate(selected, 1):
    print(f"  s{k:02d}: {r['requests']} requests, {r['compactions']} compactions, {r['first'][:10]} .. {r['last'][:10]}, models {sorted(r['models'])}")
if not selected: sys.exit('no sessions selected')
