"""Markdown tables for a forward run from the stats.py JSON files in <results dir> (none.json, off.json,
timeline.json, observation.json; whichever exist). Usage: python3 tables.py <results dir>

Percentages compare each configuration with the first baseline present: claude-mem off (`none`), else Endless off
(`off`); Endless rows also show the change vs Endless off when both baselines exist. These tables contain numbers
only (no prompts, replies or file contents), so they are safe to paste.
"""
import json, os, sys

D = sys.argv[1]
names = [('none', 'claude-mem off'), ('off', 'claude-mem on, Endless off'), ('timeline', 'Endless `timeline`'), ('observation', 'Endless `observation`')]
names = [(k, l) for k, l in names if os.path.exists(os.path.join(D, f'{k}.json'))]
R = {k: json.load(open(os.path.join(D, f'{k}.json'))) for k, _ in names}
base = next((k for k in ('none', 'off') if k in R), names[0][0])
second = 'off' if base == 'none' and 'off' in R else None
rows = ['turns', 'requests', 'output_tokens', 'final_prompt_tokens', 'max_prompt_tokens', 'tool_calls', 'file_reads', 'file_rereads',
        'cache_read', 'cache_write', 'uncached_input', 'input_cost_usd', 'output_cost_usd', 'total_cost_usd', 'measured_cost_usd']

def pct(v, b): return f'{(v / b - 1) * 100:+.1f}%' if b else 'n/a'
def cell(key, k):
    v = R[key].get(k)
    if v is None: return 'n/a'
    s = f'{v:.4f}' if isinstance(v, float) else f'{v:,}'
    if key == base or not isinstance(R[base].get(k), (int, float)): return s
    parts = [pct(v, R[base][k])]
    if second and key in ('timeline', 'observation') and isinstance(R[second].get(k), (int, float)): parts.append(pct(v, R[second][k]))
    return f"{s} ({' / '.join(parts)})"

first = R[names[0][0]]
print(f"Prices: {first['prices']['file']} ({first['prices']['source']})\n")
print(f"### Totals (% vs {dict(names)[base]}{' / % vs Endless off' if second else ''})\n")
print('| | ' + ' | '.join(l for _, l in names) + ' |'); print('|---' * (len(names) + 1) + '|')
for k in rows: print(f'| {k} | ' + ' | '.join(cell(key, k) for key, _ in names) + ' |')

turns = max(R[k]['turns'] for k, _ in names)
bucket = 10 if turns >= 20 else 1
print(f'\n### Cost per {bucket}-turn bucket (USD, input + output)\n')
print('| turns | ' + ' | '.join(l for _, l in names) + ' |'); print('|---' * (len(names) + 1) + '|')
for start in range(1, turns + 1, bucket):
    span = range(start, start + bucket)
    cells = [f"{sum(R[k]['per_turn'].get(str(t), {}).get('cost', 0) for t in span):.3f}" for k, _ in names]
    print(f"| {start if bucket == 1 else f'{start}-{start + bucket - 1}'} | " + ' | '.join(cells) + ' |')

def cumulative(key):
    pt = R[key]['per_turn']; out = {}; c = 0
    for t in range(0, turns + 1): c += pt.get(str(t), {}).get('cost', 0); out[t] = c
    return out
C = {k: cumulative(k) for k, _ in names}
print('\n### Running total cost\n')
print('| turn | ' + ' | '.join(l for _, l in names) + ' |'); print('|---' * (len(names) + 1) + '|')
for t in sorted(set(list(range(bucket * (1 if bucket == 1 else 1), turns + 1, bucket)) + [turns])):
    if t == 0: continue
    print(f'| {t} | ' + ' | '.join(f'{C[k][t]:.3f}' for k, _ in names) + ' |')
print()
for e in ('timeline', 'observation'):
    if e not in R: continue
    for b in ('none', 'off'):
        if b not in R: continue
        below = [t for t in range(1, turns + 1) if C[e][t] < C[b][t]]
        stays = [t for t in below if all(C[e][u] < C[b][u] for u in range(t, turns + 1))]
        f, s = (below[0] if below else None), (stays[0] if stays else None)
        print(f"- Endless `{e}` vs {dict(names)[b]}: " + (f'running total first below at turn {f}, and stays below from turn {s}' if s else
              f'first below at turn {f} but ends above' if f else 'never drops below') + f' (end: {C[e][turns]:.3f} vs {C[b][turns]:.3f}).')

print('\n### Compactions\n')
for k, l in names:
    c = R[k]['compactions']
    print(f'- {l}: ' + (f"none (max prompt {R[k]['max_prompt_tokens']:,} tokens)" if not c else json.dumps(c)))
print('\n### Timeline at the end\n')
for k, l in names:
    t = R[k].get('timeline_end')
    if k in ('timeline', 'observation') and t: print(f"- {l}: {t['blocks']} blocks, {t['chars']:,} chars, about {t['est_tokens']:,} tokens (chars / 4)")
print('\n### Run health\n')
for k, l in names:
    r = R[k]
    print(f"- {l}: {r['turns_started']} turns started; errors {len(r['errors'])}; spoiled turns {sorted(map(int, r['spoiled_turns'])) or 'none'}; "
          f"turn retries {r['retried_turns'] or 'none'}; unextracted request bodies {r['unextracted_bodies']}; "
          f"observer wait capped on turns {r.get('observer_wait_capped_turns') or 'none'}; observer quota pauses {r.get('observer_quota_pauses', 0)}"
          + (f"; provider-reported cost on {r['measured_cost_requests']} of {r['requests']} requests" if r.get('measured_cost_requests') else ''))
