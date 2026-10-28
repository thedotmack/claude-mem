"""Simulate the prompt cache for one session under a mode and write per-request metrics.

Modes: real (a: as recorded), o (claude-mem off, see claude_mem_off.py), b / c (Endless Mode outputs from the
gateway driver, see run_gateway.ts). Usage: python3 simulate.py <session dir> <mode> [...]
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from cache_sim import Positions, CacheSim, ts_seconds, first_divergence, cost

def recorded_total(u):
    return (u.get('input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0) + (u.get('cache_read_input_tokens') or 0)

def bp_map_from_paths(paths):
    out = {}
    for c in paths or []:
        p = c['path']; ttl = (c.get('value') or {}).get('ttl') or '5m'
        if p[0] in ('system', 'tools'): out[(p[0], p[1])] = ttl
        elif p[0] == 'messages': out[('messages', p[1], p[3] if len(p) > 3 else 0)] = ttl
    return out

def default_bps(n_system, msgs, ttl):
    """Claude Code's breakpoints when the version recorded none: the last two system blocks and the last block of the last message."""
    bps = {}
    if n_system >= 2: bps[('system', n_system - 2)] = ttl
    if n_system >= 1: bps[('system', n_system - 1)] = ttl
    if msgs: bps[('messages', len(msgs) - 1, len(msgs[-1][1]) - 1)] = ttl
    return bps

def move_last_message_bp(bps, old_msgs, new_msgs):
    """Claude Code marks the last block of the last message: keep the head's markers, put that one on the new last block."""
    out = {k: v for k, v in bps.items() if k[0] != 'messages'}
    ttls = [v for k, v in bps.items() if k[0] == 'messages']
    if new_msgs and ttls: out[('messages', len(new_msgs) - 1, len(new_msgs[-1][1]) - 1)] = ttls[-1]
    return out

def requests_for_mode(sess, mode, gateway_out=None, o_out=None):
    meta = sess['meta']; reqs = sess['requests']; ttl = meta['ttl']
    out = []
    for k, r in enumerate(reqs):
        msgs_real = r['msgs_real']
        bps_real = bp_map_from_paths(r['cache_control']) if r['cache_control'] is not None else default_bps(len(r['sys']), msgs_real, r.get('ttl', ttl))
        if mode == 'a':
            out.append(dict(tools=r['tools'], sys=r['sys'], msgs=msgs_real, bps=bps_real))
        elif mode == 'o':
            g = o_out[k]
            out.append(dict(tools=g['tools'], sys=g['sys'], msgs=g['msgs'], bps=move_last_message_bp({kk: v for kk, v in bps_real.items() if kk[0] != 'tools' or kk[1] < len(g['tools'])}, msgs_real, g['msgs'])))
        else:
            g = gateway_out[k]
            out.append(dict(tools=g['tools'], sys=g['sys'], msgs=g['msgs'], bps={tuple(x[:-1]): x[-1] for x in g['bps']}))
    return out

def simulate(sess, mode_reqs, tokens, kinds, seed_head=True, head_always_warm=True):
    reqs = sess['requests']
    sim = CacheSim(); rows = []; prev_pos = None
    for k, (r, m) in enumerate(zip(reqs, mode_reqs)):
        now = ts_seconds(r['ts'])
        pos = Positions(m['tools'], m['sys'], m['msgs'], kinds, tokens, m['bps'])
        if k == 0 and seed_head:
            # Cross-session cache: the first request read the shared head (tools + system, written by earlier
            # sessions with the same head) when its recorded cache read was > 0. Seed the deepest system
            # breakpoint whose prefix is no larger than that read.
            rec_read = r['usage'].get('cache_read_input_tokens') or 0
            if rec_read > 0:
                cands = [p for p, t in enumerate(pos.bp_ttl) if t and pos.labels[p].startswith(('system', 'tools')) and pos.cum[p] <= rec_read * 1.02 + 1]
                if cands:
                    p = max(cands); sim.seed(pos.hash[p], now, pos.bp_ttl[p], pos.cum[p], forever=head_always_warm)
        res = sim.send(pos, now)
        if head_always_warm:
            # The head (tools + system) is shared with your other sessions, which keep its entry warm
            # (system[1] carries scope: global): an entry for a head breakpoint never expires once written.
            for p, t in enumerate(pos.bp_ttl):
                if t and pos.labels[p].startswith(('system', 'tools')) and pos.hash[p] in sim.entries: sim.entries[pos.hash[p]][0] = float('inf')
        div = first_divergence(prev_pos, pos) if prev_pos is not None else None
        prev_last_bp = max([p for p, t in enumerate(prev_pos.bp_ttl) if t] or [-1]) if prev_pos is not None else -1
        # a break: this request read less than the previous request's cached prefix it still shares
        shared_through = prev_last_bp if div is None else min(prev_last_bp, div - 1)
        expected = prev_pos.cum[shared_through] if (prev_pos is not None and shared_through >= 0) else 0.0
        brk = None
        if prev_pos is not None and res['read'] + 1 < (prev_pos.cum[prev_last_bp] if prev_last_bp >= 0 else 0):
            if div is not None and div <= prev_last_bp:
                brk = 'prefix changed at ' + pos.labels[div] if div < len(pos.labels) else 'prefix changed'
            elif res['miss_reason']:
                brk = res['miss_reason']
            else:
                brk = 'other'
        out_tok = r['usage'].get('output_tokens') or 0
        res.update(i=k, ts=r['ts'], output=out_tok, cost=cost(res, out_tok), brk=brk, n_positions=len(pos.labels))
        rows.append(res); prev_pos = pos
    return rows

def load_session(d):
    sess = json.load(open(os.path.join(d, 'session.json')))
    tokens = {i: b['tokens'] for i, b in sess['blocks'].items()}
    kinds = {i: b['kind'] for i, b in sess['blocks'].items()}
    return sess, tokens, kinds

if __name__ == '__main__':
    d = sys.argv[1]
    sess, tokens, kinds = load_session(d)
    rows = simulate(sess, requests_for_mode(sess, 'a'), tokens, kinds)
    json.dump(rows, open(os.path.join(d, 'sim-a.json'), 'w'))
    # quick validation print
    import statistics
    rr = sess['requests']; n = len(rows); ok = 0
    for r, s in zip(rr, rows):
        u = r['usage']; T = recorded_total(u)
        if abs((u.get('cache_read_input_tokens') or 0) - s['read']) <= max(0.02 * T, 500): ok += 1
    rec_read = sum(r['usage'].get('cache_read_input_tokens') or 0 for r in rr); sim_read = sum(s['read'] for s in rows)
    rec_w = sum(r['usage'].get('cache_creation_input_tokens') or 0 for r in rr); sim_w = sum(s['write_1h'] + s['write_5m'] for s in rows)
    print(os.path.basename(d), n, 'read within 2%%: %d/%d' % (ok, n), 'read rec/sim %.3f' % (rec_read / max(1, sim_read)), 'write rec/sim %.3f' % (rec_w / max(1, sim_w)))
