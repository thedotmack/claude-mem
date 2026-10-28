"""Backtest tables from <out dir>/report-data.json, printed as Markdown (plus <out dir>/main-cases.json). Sessions appear
by label (s01, s02, ... in order of request count), never by id or path, so the output is safe to paste.
Usage: python3 make_tables.py <out dir>/report-data.json

Main b / c per session: sessions without a compaction use the replay with the history as recorded. Sessions
with one use the history Claude Code compacted put back (`cont`), unless the Endless Mode prompt in that replay
reached the size at which Claude Code really compacted (its smallest compaction preTokens); then the replay with
the real, compacted history (`real`) is the main case, because Claude Code would have compacted under Endless
Mode too.
"""
import json, sys, os, csv

D = json.load(open(sys.argv[1]))
out_dir = os.path.dirname(sys.argv[1])

def k(x): return f'{x / 1000:,.0f}k'
def m(x): return f'{x / 1e6:,.1f}M'
def usd(x): return f'${x:,.2f}'
def pct(x, base): return f'{(x - base) / base * 100:+.0f}%' if base else 'n/a'

main = {}
for d in D:
    s = d['summary']
    pre = [c['meta'].get('preTokens') for c in d['compactions'] if c['meta'].get('preTokens')]
    choice = {}
    for mode in ('b', 'c'):
        if not pre:
            choice[mode] = (mode, 'recorded history (no compaction)')
        elif s[mode]['peak'] >= min(pre):
            choice[mode] = (mode + '_real', f'real history: the restored-history prompt reached {k(s[mode]["peak"])} >= the {k(min(pre))} at which Claude Code compacted')
        else:
            choice[mode] = (mode, f'restored history: peak {k(s[mode]["peak"])} < the {k(min(pre))} at which Claude Code compacted')
    main[d['label']] = choice
json.dump(main, open(os.path.join(out_dir, 'main-cases.json'), 'w'), indent=1)

def S(d, mode):
    key = main[d['label']][mode][0] if mode in ('b', 'c') else mode
    return d['summary'][key]

order = sorted(D, key=lambda d: -d['requests'])
print('### Cost per session (USD; % vs o = claude-mem off)\n')
print('| session | requests | typed prompts / gateway turn starts | compactions | o | a | b (timeline) | c (observation) | b/c history used |')
print('|---|---|---|---|---|---|---|---|---|')
tot = {x: 0.0 for x in ('o', 'a', 'b', 'c', 'rec')}
for d in order:
    o, a, b, c = (S(d, x)['cost'] for x in ('o', 'a', 'b', 'c'))
    for x, v in zip(('o', 'a', 'b', 'c'), (o, a, b, c)): tot[x] += v
    tot['rec'] += d['summary']['recorded']['cost']
    comp = len(d['compactions'])
    hist = 'recorded' if not d['compactions'] else ('real (compacted)' if main[d['label']]['b'][0].endswith('_real') else 'restored (uncompacted)')
    print(f"| {d['label']} | {d['requests']} | {d['user_prompts']} / {d['gateway'].get('b', {}).get('turn_starts', '?')} | {comp} | {usd(o)} | {usd(a)} ({pct(a, o)}) | {usd(b)} ({pct(b, o)}; vs a {pct(b, a)}) | {usd(c)} ({pct(c, o)}; vs a {pct(c, a)}) | {hist} |")
print(f"| **total** | {sum(d['requests'] for d in D):,} | | {sum(len(d['compactions']) for d in D)} | **{usd(tot['o'])}** | **{usd(tot['a'])}** ({pct(tot['a'], tot['o'])}) | **{usd(tot['b'])}** ({pct(tot['b'], tot['o'])}; vs a {pct(tot['b'], tot['a'])}) | **{usd(tot['c'])}** ({pct(tot['c'], tot['o'])}; vs a {pct(tot['c'], tot['a'])}) | |")
print(f"\nRecorded cost (the real usage priced the same way): {usd(tot['rec'])}.\n")

print('### Cache and prompt size per session (o / a / b / c)\n')
print('| session | cache read | cache write | cache breaks | peak prompt | final prompt |')
print('|---|---|---|---|---|---|')
T = {x: {'read': 0, 'write': 0, 'breaks': 0} for x in 'oabc'}
for d in order:
    cols = []
    for f in ('read', 'write'):
        cols.append(' / '.join(m(S(d, x)[f]) for x in 'oabc'))
    cols.append(' / '.join(str(S(d, x)['breaks']) for x in 'oabc'))
    cols.append(' / '.join(k(S(d, x)['peak']) for x in 'oabc'))
    cols.append(' / '.join(k(S(d, x)['final']) for x in 'oabc'))
    for x in 'oabc':
        for f in ('read', 'write', 'breaks'): T[x][f] += S(d, x)[f]
    print(f"| {d['label']} | " + ' | '.join(cols) + ' |')
print('| **total** | ' + ' / '.join(m(T[x]['read']) for x in 'oabc') + ' | ' + ' / '.join(m(T[x]['write']) for x in 'oabc') + ' | ' + ' / '.join(str(T[x]['breaks']) for x in 'oabc') + ' | | |')

print('\n### Where the cache broke (count of requests, by cause; all sessions)\n')
import collections
W = {x: collections.Counter() for x in 'oabc'}
for d in D:
    for x in 'oabc':
        for where, n in S(d, x)['break_where']: W[x]['prefix changed' if where.startswith('prefix') else where] += n
print('| cause | o | a | b | c |\n|---|---|---|---|---|')
for cause in sorted(set().union(*W.values())):
    print(f'| {cause} | ' + ' | '.join(str(W[x][cause]) for x in 'oabc') + ' |')

print('\n### Validation of the simulator against recorded usage (case a)\n')
print('| session | how rebuilt | requests | sim cache read within 2% (or 500 tok) of recorded | sim cache write within 2% | recorded / sim read | recorded / sim write | recorded cost | simulated a cost |')
print('|---|---|---|---|---|---|---|---|---|')
V = dict(n=0, r=0, w=0, rr=0, sr=0, rw=0, sw=0, rc=0, sc=0)
for d in order:
    v = d['validation']
    kinds = d['real_kinds']; how = 'Claude Code request records' if d['mode'] == 'exact' else 'transcript chain'
    V['n'] += v['n']; V['r'] += v['read_within']; V['w'] += v['write_within']; V['rr'] += v['rec_read']; V['sr'] += v['sim_read']; V['rw'] += v['rec_write']; V['sw'] += v['sim_write']; V['rc'] += v['rec_cost']; V['sc'] += v['sim_cost']
    print(f"| {d['label']} | {how} | {v['n']} | {v['read_within']} ({v['read_within'] / v['n'] * 100:.0f}%) | {v['write_within']} ({v['write_within'] / v['n'] * 100:.0f}%) | {v['rec_read'] / max(1, v['sim_read']):.3f} | {v['rec_write'] / max(1, v['sim_write']):.3f} | {usd(v['rec_cost'])} | {usd(v['sim_cost'])} |")
print(f"| **all** | | {V['n']} | {V['r']} ({V['r'] / V['n'] * 100:.1f}%) | {V['w']} ({V['w'] / V['n'] * 100:.1f}%) | {V['rr'] / V['sr']:.3f} | {V['rw'] / V['sw']:.3f} | {usd(V['rc'])} | {usd(V['sc'])} |")

print('\n### Endless Mode activity (b = timeline rows; restored or recorded history as used above)\n')
print('| session | gateway turn starts | folds (whole turns) | observation rows | culled tokens (stage estimate) | thinking cuts recorded | requests without a timeline | final prompt thinking tokens a -> b |')
print('|---|---|---|---|---|---|---|---|')
for d in order:
    g = d['gateway'].get(main[d['label']]['b'][0]) or d['gateway'].get('b', {})
    th = d.get('thinking', {})
    print(f"| {d['label']} | {g.get('turn_starts')} | {g.get('folds')} ({g.get('whole_turn_folds')}) | {g.get('observation_rows')} | {k(g.get('culled_tokens_est', 0))} | {g.get('thinking_cuts')} | {g.get('requests_without_timeline')} | {k(th.get('cont_final', 0))} -> {k(th.get('b_final', 0))} |")

print('\n### Compaction\n')
print('| session | compactions (request index, trigger, tokens before) | a peak | b peak, restored history | c peak, restored history | reaches the compaction size under b / c? | b cost restored / real | c cost restored / real |')
print('|---|---|---|---|---|---|---|---|')
for d in order:
    if not d['compactions']: continue
    s = d['summary']; pre = [c['meta'].get('preTokens') for c in d['compactions']]
    idx = d['compaction_requests']
    comps = '; '.join(f"#{i} {c['meta'].get('trigger')} {k(c['meta'].get('preTokens') or 0)}" for i, c in zip(idx + [None] * len(d['compactions']), d['compactions']))
    reach = ' / '.join('yes' if s[x]['peak'] >= min(p for p in pre if p) else 'no' for x in ('b', 'c'))
    print(f"| {d['label']} | {comps} | {k(s['a']['peak'])} | {k(s['b']['peak'])} | {k(s['c']['peak'])} | {reach} | {usd(s['b']['cost'])} / {usd(s['b_real']['cost']) if 'b_real' in s else '-'} | {usd(s['c']['cost'])} / {usd(s['c_real']['cost']) if 'c_real' in s else '-'} |")

print('\n### Observation mapping\n')
print('| session | method | main-thread tool calls | with an observation | observation rows (batches) | observation timing | median / p90 store lag after the event |')
print('|---|---|---|---|---|---|---|')
for d in order:
    mp = d['mapping']; c = mp.get('counts', {})
    method = 'tool_uses.tool_use_id = transcript tool_use id; batch = worker STORED log line' if c.get('tool_uses') else 'none found (no tool_uses rows, no sdk_sessions row)'
    timing = f"STORED log line for {c.get('linked_with_log_time', 0)}, created_at only for {c.get('linked_created_at_only', 0)}" if c.get('tool_uses') else '-'
    lag = f"{mp.get('store_lag_seconds_median') or 0:,.0f} s / {mp.get('store_lag_seconds_p90') or 0:,.0f} s" if mp.get('store_lag_seconds_median') is not None else '-'
    print(f"| {d['label']} | {method} | {mp['main_thread_calls']} | {mp['calls_with_observation']} | {c.get('batch_rows', 0)} | {timing} | {lag} |")

print('\n### What case o removed (tokens, each block counted once where it entered the context)\n')
print('| session | hook context | claude-mem MCP tool definitions / loads | claude-mem tool calls and results | prompt tokens removed over all requests (a - o) |')
print('|---|---|---|---|---|')
for d in order:
    r = d['o_removed'] or {}
    tool_defs = r.get('claude-mem MCP tool definitions', 0) + r.get('claude-mem MCP tool definitions (tool list)', 0)
    diff = d['summary']['a']['prompt'] - d['summary']['o']['prompt']
    print(f"| {d['label']} | {k(r.get('hook context', 0))} | {k(tool_defs)} | {k(r.get('claude-mem tool calls and results', 0))} | {m(diff)} |")
