"""Anthropic prompt-cache simulator with token accounting and TTLs.

Prefix model: the rules of tests/wire-gateway/helpers/anthropic-cache-model.ts, ported:
- positions in render order tools -> system -> messages; a run of consecutive tool_use blocks (or tool_result
  blocks) in one message is one position; each position carries the hash of the whole prefix through it
  (cache_control is not part of the prefix; a role marker separates messages);
- a breakpoint (a block with cache_control) looks back at most 20 positions, itself first, for an entry;
  the request reads the deepest entry any breakpoint finds;
- every breakpoint writes an entry for its prefix.
Added here (the helper leaves them out): token counts per position, and TTLs: an entry lives `ttl` after its
last write or read ("refreshed at no additional cost each time the cached content is used"); 5m = 300 s,
1h = 3600 s.
Billing per request: cache_read = tokens through the entry read; cache_write = tokens from there through the
last breakpoint (split 1h / 5m by the breakpoint TTLs: tokens up to the last 1h breakpoint are 1h writes);
uncached input = the rest after the last breakpoint.
"""
import hashlib
from datetime import datetime

LOOKBACK = 20
TTL_SECONDS = {'5m': 300, '1h': 3600}

def ts_seconds(ts):
    return datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()

class Positions:
    """Positions of one request: labels, cumulative tokens, prefix hashes, breakpoint TTLs."""
    def __init__(self, tools, system, messages, kinds, tokens, breakpoints):
        # tools/system: lists of block ids; messages: [[role, [ids]]]; breakpoints: {('tools'|'system', i) or ('messages', mi, bi): ttl}
        self.labels = []; self.cum = []; self.hash = []; self.bp_ttl = []; self.block_pos = {}
        h = hashlib.sha256(); total = 0.0; open_run = None
        def add(label, block_id, run_kind, ttl):
            nonlocal total, open_run
            h.update(block_id.encode()); total += tokens.get(block_id, 0.0)
            ph = h.copy().hexdigest()
            if run_kind is not None and run_kind == open_run:
                self.cum[-1] = total; self.hash[-1] = ph
                if ttl: self.bp_ttl[-1] = ttl if self.bp_ttl[-1] is None or ttl == '1h' else self.bp_ttl[-1]
            else:
                self.labels.append(label); self.cum.append(total); self.hash.append(ph); self.bp_ttl.append(ttl)
                open_run = run_kind
            return len(self.labels) - 1
        for i, b in enumerate(tools): add(f'tools[{i}]', b, None, breakpoints.get(('tools', i)))
        for i, b in enumerate(system): add(f'system[{i}]', b, None, breakpoints.get(('system', i)))
        for mi, (role, ids) in enumerate(messages):
            h.update(f'\0{role}\0'.encode()); open_run = None
            for bi, b in enumerate(ids):
                k = kinds.get(b)
                self.block_pos[(mi, bi)] = add(f'messages[{mi}][{bi}]', b, k if k in ('tool_use', 'tool_result') else None, breakpoints.get(('messages', mi, bi)))
        self.total = total

class CacheSim:
    def __init__(self):
        self.entries = {}  # prefix hash -> [expires_at_seconds, ttl_seconds, tokens]
        self.ever = set()

    def seed(self, prefix_hash, now, ttl, tokens, forever=False):
        self.entries[prefix_hash] = [float('inf') if forever else now + TTL_SECONDS[ttl], TTL_SECONDS[ttl], tokens]
        self.ever.add(prefix_hash)

    def send(self, pos, now):
        bps = [p for p, t in enumerate(pos.bp_ttl) if t]
        best = -1; expired_candidate = -1; beyond_lookback = -1
        for p in bps:
            for back in range(p, max(-1, p - LOOKBACK), -1):
                e = self.entries.get(pos.hash[back])
                if e is None: continue
                if e[0] >= now:
                    best = max(best, back)
                    break
                expired_candidate = max(expired_candidate, back)
                break
        # the deepest position any earlier request ever cached (ignoring TTL and lookback): what could have been read
        could = -1
        for p in range(len(pos.hash) - 1, -1, -1):
            if pos.hash[p] in self.ever: could = p; break
        read = pos.cum[best] if best >= 0 else 0.0
        if best >= 0:
            e = self.entries[pos.hash[best]]; e[0] = max(e[0], now + e[1])
        last_bp = bps[-1] if bps else -1
        w1h = w5m = 0.0
        if last_bp > best:
            last_1h = max([p for p in bps if pos.bp_ttl[p] == '1h'] or [-1])
            start = read
            if last_1h > best:
                w1h = pos.cum[last_1h] - start; start = pos.cum[last_1h]
            w5m = max(0.0, pos.cum[last_bp] - start)
        for p in bps:
            ttl = TTL_SECONDS[pos.bp_ttl[p]]
            e = self.entries.get(pos.hash[p])
            if e is None or e[0] < now: self.entries[pos.hash[p]] = [now + ttl, ttl, pos.cum[p]]
            else: e[0] = max(e[0], now + ttl)
            self.ever.add(pos.hash[p])
        cached_through = max(read, pos.cum[last_bp] if last_bp >= 0 else 0.0)
        uncached = max(0.0, pos.total - cached_through)
        reason = None
        if could > best:
            if best < 0 and could >= 0 and expired_candidate >= 0: reason = 'ttl'
            elif expired_candidate > best: reason = 'ttl'
            else: reason = 'lookback'
        return dict(prompt=pos.total, read=read, write_1h=w1h, write_5m=w5m, uncached=uncached, read_label=pos.labels[best] if best >= 0 else None,
                    could_label=pos.labels[could] if could >= 0 else None, could_tokens=pos.cum[could] if could >= 0 else 0.0, miss_reason=reason)

def first_divergence(prev_pos, pos):
    """Index of the first position whose prefix differs from the previous request's; None when this request extends it."""
    n = min(len(prev_pos.hash), len(pos.hash))
    for i in range(n):
        if prev_pos.hash[i] != pos.hash[i]: return i
    return None

def _load_prices():
    """USD per million tokens from the prices file (EMV_PRICES, default prices/anthropic-claude-opus-5-5.json: the list
    prices every number in our reports uses)."""
    import json, os
    path = os.environ.get('EMV_PRICES') or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'prices', 'anthropic-claude-opus-5-5.json')
    p = json.load(open(path))
    return {'input': p['input'], 'write_5m': p['cache_write_5m'], 'write_1h': p['cache_write_1h'], 'read': p['cache_read'], 'output': p['output']}

PRICES = _load_prices()

def cost(m, output_tokens):
    return (m['uncached'] * PRICES['input'] + m['write_5m'] * PRICES['write_5m'] + m['write_1h'] * PRICES['write_1h']
            + m['read'] * PRICES['read'] + output_tokens * PRICES['output']) / 1e6
