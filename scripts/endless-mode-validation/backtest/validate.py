"""Step 1 of every backtest: does the cache simulator reproduce YOUR recorded usage? Case a (your sessions as they
really ran) is simulated and compared with the usage Claude Code recorded for every request. Endless Mode numbers are
only worth anything if this passes, so run.sh stops when it fails.

Usage: python3 validate.py <sessions dir> <labels.json> <out dir>   (exit 0 = pass, 1 = fail)
Writes <out dir>/validation.md (safe to paste: session labels, counts and dollar totals only) and validation.json.

Per request, the simulated cache read agrees when it is within 2% of the request's recorded prompt size, or 500
tokens, of the recorded read (the tolerance of our report). The run passes when both hold:
- at least 95% of all requests agree. Reason: ours was 97.8%, including one resumed session that agreed on 21%
  (99.7% without it); 95% allows a little over twice our share of disagreeing requests (2.2%), no more.
- simulated total cost is within 2% of the recorded usage priced the same way. Reason: ours was +0.9%; the Endless
  Mode differences we report are around 20%, and 2% (about twice our error) keeps the simulator's error an order of
  magnitude below them.
"""
import json, os, sys, glob

READ_TOLERANCE_SHARE, READ_TOLERANCE_TOKENS = 0.02, 500
MIN_AGREEING_SHARE = 0.95
MAX_COST_ERROR = 0.02

root, labels_file, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
labels = json.load(open(labels_file))
os.makedirs(out_dir, exist_ok=True)
rows = []; T = dict(n=0, ok=0, okw=0, rec_cost=0.0, sim_cost=0.0, rec_read=0.0, sim_read=0.0, rec_write=0.0, sim_write=0.0)
for p in sorted(glob.glob(os.path.join(root, '*', 'sim-a.json'))):
    sid8 = os.path.basename(os.path.dirname(p)); sim = json.load(open(p))
    a, rec = sim['a'], sim['recorded']
    tol = lambda y: max(READ_TOLERANCE_SHARE * y['prompt'], READ_TOLERANCE_TOKENS)
    ok = sum(1 for x, y in zip(a, rec) if abs(x['read'] - y['read']) <= tol(y))
    okw = sum(1 for x, y in zip(a, rec) if abs((x['write_1h'] + x['write_5m']) - (y['write_1h'] + y['write_5m'])) <= tol(y))
    r = dict(label=labels.get(sid8, sid8), requests=len(a), read_agree=ok, write_agree=okw,
             rec_cost=sum(y['cost'] for y in rec), sim_cost=sum(x['cost'] for x in a),
             rec_read=sum(y['read'] for y in rec), sim_read=sum(x['read'] for x in a),
             rec_write=sum(y['write_1h'] + y['write_5m'] for y in rec), sim_write=sum(x['write_1h'] + x['write_5m'] for x in a))
    rows.append(r)
    for k, v in (('n', r['requests']), ('ok', ok), ('okw', okw), ('rec_cost', r['rec_cost']), ('sim_cost', r['sim_cost']), ('rec_read', r['rec_read']),
                 ('sim_read', r['sim_read']), ('rec_write', r['rec_write']), ('sim_write', r['sim_write'])): T[k] += v
if not T['n']: sys.exit('validate: no sessions with sim-a.json')
share = T['ok'] / T['n']; cost_error = T['sim_cost'] / T['rec_cost'] - 1 if T['rec_cost'] else float('inf')
passed = share >= MIN_AGREEING_SHARE and abs(cost_error) <= MAX_COST_ERROR
rows.sort(key=lambda r: r['label'])
md = ['## Validation: simulated case a vs your recorded usage', '',
      f"**{'PASS' if passed else 'FAIL'}**: cache read agrees on {T['ok']:,} of {T['n']:,} requests ({share * 100:.1f}%; needs >= {MIN_AGREEING_SHARE * 100:.0f}%), "
      f"simulated cost ${T['sim_cost']:,.2f} vs recorded ${T['rec_cost']:,.2f} ({cost_error * 100:+.1f}%; needs within ±{MAX_COST_ERROR * 100:.0f}%). "
      f"Recorded/simulated cache read {T['rec_read'] / max(1, T['sim_read']):.3f}, write {T['rec_write'] / max(1, T['sim_write']):.3f}.", '',
      '| session | requests | read agrees | write agrees | recorded / sim read | recorded / sim write | recorded cost | simulated cost |', '|---|---|---|---|---|---|---|---|']
for r in rows:
    md.append(f"| {r['label']} | {r['requests']} | {r['read_agree']} ({r['read_agree'] / r['requests'] * 100:.0f}%) | {r['write_agree']} ({r['write_agree'] / r['requests'] * 100:.0f}%) | "
              f"{r['rec_read'] / max(1, r['sim_read']):.3f} | {r['rec_write'] / max(1, r['sim_write']):.3f} | ${r['rec_cost']:,.2f} | ${r['sim_cost']:,.2f} |")
open(os.path.join(out_dir, 'validation.md'), 'w').write('\n'.join(md) + '\n')
json.dump(dict(passed=passed, read_agree_share=share, cost_error=cost_error, totals=T, sessions=rows,
               thresholds=dict(min_agreeing_share=MIN_AGREEING_SHARE, max_cost_error=MAX_COST_ERROR, read_tolerance_share=READ_TOLERANCE_SHARE,
                               read_tolerance_tokens=READ_TOLERANCE_TOKENS)), open(os.path.join(out_dir, 'validation.json'), 'w'), indent=1)
print('\n'.join(md))
sys.exit(0 if passed else 1)
