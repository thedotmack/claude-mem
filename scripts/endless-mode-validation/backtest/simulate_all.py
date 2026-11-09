"""Simulate o / a / b / c for every session dir that has the inputs; write per-request metrics to sim.json.

Usage: python3 simulate_all.py <sessions dir> [only: a]
  a         the sessions as recorded (claude-mem on, Endless off); validated against the recorded usage
  o         claude-mem off: everything claude-mem added taken out (claude_mem_off.py)
  b / c     Endless Mode, row format `timeline` / `observation` (run-gateway.ts), plus b_real / c_real: the same
            replayed over the real, compacted history for sessions that compacted
With `a` as the second argument only the recorded usage and case a are simulated (the validation step).
"""
import json, os, sys, glob, statistics
sys.path.insert(0, os.path.dirname(__file__))
from simulate import load_session, requests_for_mode, simulate, recorded_total
from build_sessions import weight_chars, images_in, IMAGE_TOKENS
from cache_sim import cost

# Characters per token for text no recorded request carried (the gateway's timeline rows and markers, and
# continuation-only blocks), measured on YOUR sessions: characters / output_tokens over the main-thread responses
# that were text only (no thinking, no tool call) and >= 100 tokens, median; the same rule as our measurement, so the
# two are comparable. With no such response, 2.80, the value we measured that way on our 39 sessions (195 responses;
# p10 2.51, p90 3.07).
OUR_MEASURED_CHARS_PER_TOKEN = 2.80

def measure_chars_per_token(session_dirs):
    ratios = []
    for sdir in session_dirs:
        sess, _, _ = load_session(sdir)
        for r in sess['requests']:
            # A response block no later request carried is not in the block table; such a response is skipped.
            if not r['resp'] or any(i not in sess['blocks'] for i in r['resp']): continue
            kinds = [sess['blocks'][i]['kind'] for i in r['resp']]
            out = r['usage'].get('output_tokens') or 0
            if out < 100 or any(k != 'text' for k in kinds): continue
            chars = sum(len(json.loads(sess['blocks'][i]['raw']).get('text', '')) for i in r['resp'])
            ratios.append(chars / out)
    if not ratios: return OUR_MEASURED_CHARS_PER_TOKEN, 0
    return statistics.median(ratios), len(ratios)

def tokens_for_new(raw, cpt):
    b = json.loads(raw)
    return (weight_chars(b) or 0) / cpt + images_in(b) * IMAGE_TOKENS

def recorded_rows(sess):
    rec = []
    for r in sess['requests']:
        u = r['usage']; cc = u.get('cache_creation') or {}
        w1 = cc.get('ephemeral_1h_input_tokens'); w5 = cc.get('ephemeral_5m_input_tokens')
        if w1 is None and w5 is None:
            w = u.get('cache_creation_input_tokens') or 0; w1, w5 = (w, 0) if sess['meta']['ttl'] == '1h' else (0, w)
        m = dict(prompt=recorded_total(u), read=u.get('cache_read_input_tokens') or 0, write_1h=w1 or 0, write_5m=w5 or 0, uncached=u.get('input_tokens') or 0)
        m['cost'] = cost(m, u.get('output_tokens') or 0); m['output'] = u.get('output_tokens') or 0
        rec.append(m)
    return rec

def run(sdir, cpt, only_a=False):
    sess, tokens, kinds = load_session(sdir)
    for i, b in sess['blocks'].items():
        if b.get('how') == 'chars (continuation only)': tokens[i] = tokens_for_new(b['raw'], cpt)
    res = {'chars_per_token': cpt, 'a': simulate(sess, requests_for_mode(sess, 'a'), tokens, kinds), 'recorded': recorded_rows(sess)}
    if only_a: return res
    if os.path.exists(os.path.join(sdir, 'o.json')):
        o = json.load(open(os.path.join(sdir, 'o.json')))
        t2 = dict(tokens); k2 = dict(kinds)
        for i, b in o['new_blocks'].items(): t2[i] = b['tokens']; k2[i] = b['kind']
        res['o'] = simulate(sess, requests_for_mode(sess, 'o', o_out=o['requests']), t2, k2)
    for mode, fmt, suffix in (('b', 'timeline', ''), ('c', 'observation', ''), ('b_real', 'timeline', '-real'), ('c_real', 'observation', '-real')):
        p = os.path.join(sdir, f'gateway-{fmt}{suffix}.json')
        if not os.path.exists(p): continue
        g = json.load(open(p))
        t2 = dict(tokens); k2 = dict(kinds)
        for i, raw in g['new_blocks'].items():
            t2[i] = tokens_for_new(raw, cpt); k2[i] = json.loads(raw).get('type')
        res[mode] = simulate(sess, requests_for_mode(sess, mode, gateway_out=g['requests']), t2, k2)
        res[mode + '_meta'] = [dict(turn=x['turn'], within_turn=x['within_turn'], has_timeline=x['has_timeline']) for x in g['requests']]
    return res

if __name__ == '__main__':
    root = sys.argv[1]; only_a = len(sys.argv) > 2 and sys.argv[2] == 'a'
    dirs = sorted(os.path.dirname(d) for d in glob.glob(os.path.join(root, '*', 'session.json')))
    cpt, n = measure_chars_per_token(dirs)
    print(f'chars per token for new text: {cpt:.2f} ' + (f'(median over {n} of your text-only replies)' if n else '(none of your replies qualified: our measured 2.80)'), flush=True)
    for sdir in dirs:
        res = run(sdir, cpt, only_a)
        json.dump(res, open(os.path.join(sdir, 'sim-a.json' if only_a else 'sim.json'), 'w'))
        print(os.path.basename(sdir), *('%s $%.2f' % (m, sum(x['cost'] for x in res[m])) for m in ('recorded', 'a', 'o', 'b', 'c') if m in res), flush=True)
