"""Build each selected session's request list in a compact form for the backtest.

For every main-thread API request (one per assistant message id with usage) it records:
- the recorded usage, timestamp and response;
- the request as sent (`real`): exact from Claude Code's api-request records when the session has them
  (>= 2.1.300), else rebuilt from the transcript chain (generic_requests.messages_of_chain);
- the same request with the history Claude Code compacted put back (`cont`, used for Endless Mode b/c):
  the pre-compaction history continued by the post-compaction messages, the compaction summary left out.
Blocks are stored once (id = sha256 of the block's canonical JSON without cache_control) with a token count
attributed from the recorded usage (see attribute_tokens).

Usage: python3 build_sessions.py <selected-sessions.json> <out dir>
"""
import json, sys, os, hashlib, bisect, collections, re
sys.path.insert(0, os.path.dirname(__file__))
from exact_requests import load, exact_requests, H
from generic_requests import messages_of_chain, _blocks

def canon(block):
    return json.dumps({k: v for k, v in block.items() if k != 'cache_control'}, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
def bid(block): return hashlib.sha256(canon(block).encode()).hexdigest()[:24]
def raw(block): return json.dumps({k: v for k, v in block.items() if k != 'cache_control'}, separators=(',', ':'), ensure_ascii=False)

# Characters per token used only to WEIGHT blocks inside one request's measured token delta, and for blocks
# that never appear in a recorded request (the gateway's timeline rows). Calibrated per session below.
DEFAULT_CHARS_PER_TOKEN = 3.3
IMAGE_TOKENS = 1600
HEAD_CHARS_PER_TOKEN_DEFAULT = float(os.environ.get('HEAD_CHARS_PER_TOKEN_DEFAULT', '3.79'))  # Anthropic: an image costs about (width*height)/750 tokens, ~1.6k for a 1092x1092 screenshot.

def weight_chars(block):
    t = block.get('type')
    if t == 'image': return None
    if t == 'text': return len(block.get('text', ''))
    if t == 'thinking': return len(block.get('thinking', ''))
    if t == 'redacted_thinking': return len(block.get('data', '')) * 0.75
    if t == 'tool_result':
        c = block.get('content')
        if isinstance(c, list):
            return sum(len(x.get('text', '')) if x.get('type') == 'text' else 0 for x in c) + 40
        return len(c or '') + 40
    return len(raw(block))

def images_in(block):
    if block.get('type') == 'image': return 1
    if block.get('type') == 'tool_result' and isinstance(block.get('content'), list):
        return sum(1 for x in block['content'] if x.get('type') == 'image')
    return 0

PREAMBLE_ATTACHMENTS_OK = True

PRE_LEAF = {}  # compact_boundary uuid -> the last main-thread entry written before it (file order)

def index_pre_leaves(rows):
    PRE_LEAF.clear(); last = None
    for d in rows:
        if d.get('isSidechain'): continue
        if d.get('type') == 'system' and d.get('subtype') == 'compact_boundary':
            PRE_LEAF[d['uuid']] = last
        elif d.get('type') in ('user', 'assistant', 'attachment') and d.get('uuid'):
            last = d['uuid']

def chain_of(byuuid, start_uuid, continue_through_compaction):
    """Entries from the root to start_uuid. With continue_through_compaction, a compact_boundary jumps to the
    entry the summary replaced (logicalParentUuid) and the compaction preamble after it is left out."""
    chain = []; u = start_uuid; guard = 0; visited_boundaries = set()
    while u and u in byuuid and guard < 500000:
        e = byuuid[u]; guard += 1
        if e.get('type') == 'system' and e.get('subtype') == 'compact_boundary':
            if not continue_through_compaction:
                chain.append(e); break
            # drop the preamble: entries after the boundary up to the first assistant entry or real user prompt
            k = len(chain) - 1
            while k >= 0:
                x = chain[k]
                is_pre = (x.get('type') == 'attachment' or (x.get('type') == 'user' and (x.get('isCompactSummary') or x.get('isMeta'))) or x.get('type') == 'system')
                if not is_pre: break
                k -= 1
            del chain[k + 1:]
            # the history the summary replaced: the last main-thread entry before the boundary in the file
            # (logicalParentUuid can point into a later compaction's preamble, seen in a real session)
            nxt = PRE_LEAF.get(e['uuid'])
            if nxt in visited_boundaries: break
            visited_boundaries.add(e['uuid']); u = nxt; continue
        chain.append(e)
        u = e.get('parentUuid')
    chain.reverse()
    return [e for e in chain if not (e.get('type') == 'system')]

def build_session(path):
    rows = load(path)
    sid = os.path.basename(path)[:-6]
    byuuid = {d['uuid']: d for d in rows if d.get('uuid')}
    index_pre_leaves(rows)
    results_by_call = {}
    for d in rows:
        if d.get('type') == 'user' and not d.get('isSidechain') and isinstance(d['message'].get('content'), list):
            for b in d['message']['content']:
                if b.get('type') == 'tool_result' and b.get('tool_use_id') not in results_by_call:
                    results_by_call[b['tool_use_id']] = (d.get('timestamp') or '', b)
    groups = collections.OrderedDict(); line_of = {}
    for n, d in enumerate(rows):
        if d.get('uuid'): line_of.setdefault(d['uuid'], n)
    for d in rows:
        if d.get('type') == 'assistant' and not d.get('isSidechain'):
            m = d.get('message') or {}
            if m.get('model') == '<synthetic>' or not m.get('usage'): continue
            groups.setdefault(m['id'], []).append(d)
    order = list(groups); prev_last_line = {m: (line_of[groups[order[k - 1]][-1]['uuid']] if k > 0 else None) for k, m in enumerate(order)}
    compactions = [d for d in rows if d.get('type') == 'system' and d.get('subtype') == 'compact_boundary' and not d.get('isSidechain')]
    exact = [r for r in exact_requests(rows) if r['querySource'] in ('repl_main_thread', 'sdk')]
    ets = [r['line_no'] for r in exact]
    mode = 'exact' if exact else 'generic'

    reqs = []
    for mid, ents in groups.items():
        first = ents[0]
        rec = dict(message_id=mid, ts=first['timestamp'], usage=ents[-1]['message']['usage'], model=first['message'].get('model'),
                   first_uuid=first['uuid'], response=[b for g in ents for b in g['message']['content']],
                   version=first.get('version'))
        real_chain = chain_of(byuuid, first.get('parentUuid'), False)
        cont_chain = chain_of(byuuid, first.get('parentUuid'), True)
        rec['real_generic'] = messages_of_chain(real_chain, results_by_call, first['timestamp'])
        rec['cont_chain_uuids'] = [e['uuid'] for e in cont_chain]
        rec['cont_chain'] = cont_chain
        rec['after_compaction'] = any(e.get('type') == 'user' and e.get('isCompactSummary') for e in real_chain) or bool(real_chain and real_chain[0].get('type') == 'system')
        e = None
        if mode == 'exact':
            # the api-request record is written when the request is sent, before its response's entries
            i = bisect.bisect_right(ets, line_of[first['uuid']]) - 1
            e = exact[i] if i >= 0 else None
            if e is not None and prev_last_line.get(mid) is not None and e['line_no'] < prev_last_line[mid]: e = None
        rec['exact'] = e
        reqs.append(rec)

    # The real request: exact when resolvable; an unresolved message is filled from the rebuilt one at the same index.
    fills = {}
    generic_by_hash = {}
    for r in reqs:
        for gm in r['real_generic']: generic_by_hash.setdefault(H(gm), gm)
    for r in reqs:
        e = r['exact']
        if e is not None and e['messages'] is not None:
            msgs = []
            for k, m in enumerate(e['messages']):
                if '_unresolved' in m:
                    h = m['_unresolved']
                    if h not in fills and h in generic_by_hash:
                        fills[h] = generic_by_hash[h]
                    if h not in fills:
                        g = r['real_generic']
                        fills[h] = g[k] if k < len(g) else {'role': 'user', 'content': [{'type': 'text', 'text': '[unresolved]'}]}
                    msgs.append(fills[h])
                else:
                    msgs.append(m)
            r['real_messages'] = msgs; r['real_kind'] = 'exact' if not any('_unresolved' in m for m in e['messages']) else 'exact-filled'
        else:
            r['real_messages'] = r['real_generic']; r['real_kind'] = 'generic'
    # Continuation messages (history Claude Code compacted kept): exact sessions build on the exact request
    # before the first compaction, then the rebuilt tail; sessions without compaction: same as real.
    cont_by_mid = {}
    for k, r in enumerate(reqs):
        if not compactions or not r['after_compaction']:
            r['cont_messages'] = r['real_messages']; r['cont_kind'] = r['real_kind']
        else:
            # the latest earlier request that is not after a compaction (or already continued): find its response in our chain
            chain = r['cont_chain']; pos = {e['uuid']: i for i, e in enumerate(chain)}
            base = None
            for j in range(k - 1, -1, -1):
                p = reqs[j]
                if p['first_uuid'] in pos and p['real_kind'].startswith('exact') and not p['after_compaction']:
                    base = p; break
            if base is not None:
                r['cont_messages'] = base['real_messages'] + messages_of_chain(chain[pos[base['first_uuid']]:], results_by_call, r['ts'])
                r['cont_kind'] = 'exact+rebuilt-tail'
            else:
                r['cont_messages'] = messages_of_chain(chain, results_by_call, r['ts']); r['cont_kind'] = 'rebuilt'
        r.pop('cont_chain', None)

    # system + tools (a request with no record, e.g. the first, borrows the head of the nearest record)
    for k, r in enumerate(reqs):
        if r['exact'] is None and mode == 'exact':
            near = next((reqs[j]['exact'] for j in list(range(k + 1, len(reqs))) + list(range(k - 1, -1, -1)) if reqs[j]['exact'] is not None), None)
            if near is not None: r['exact_head_only'] = near
    for r in reqs:
        e = r['exact'] or r.get('exact_head_only')
        if e is not None and e.get('shape'):
            r['system'] = e['shape'].get('system') or []
            # Tools with defer_loading are not rendered into the prompt (their schemas reach the model through
            # tool_reference / tool_addition blocks in the messages), so they are left out of the head.
            all_tools = e['shape'].get('tools') or []
            r['tools'] = [t for t in all_tools if not t.get('defer_loading')]
            r['deferred_tool_names'] = [t.get('name') for t in all_tools if t.get('defer_loading')]
            r['cache_control'] = (e.get('cacheControl') or []) if r['exact'] is not None else None
            r['params'] = e.get('params') or {}
        else:
            r['system'] = None; r['tools'] = None; r['cache_control'] = None; r['params'] = {}; r['deferred_tool_names'] = None
    return dict(session_id=sid, path=path, mode=mode, requests=reqs, compactions=[dict(ts=c['timestamp'], meta={k: v for k, v in (c.get('compactMetadata') or {}).items() if k in ('trigger', 'preTokens', 'postTokens')}) for c in compactions])

# ---------------------------------------------------------------------------------------------
# Token attribution
# ---------------------------------------------------------------------------------------------
def recorded_total(u):
    return (u.get('input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0) + (u.get('cache_read_input_tokens') or 0)

class BlockTable:
    def __init__(self):
        self.raw = {}; self.tokens = {}; self.kind = {}; self.how = {}
    def add(self, block):
        i = bid(block)
        if i not in self.raw:
            self.raw[i] = raw(block); self.kind[i] = block.get('type')
        return i

def ttl_of_session(reqs):
    one_h = sum((r['usage'].get('cache_creation') or {}).get('ephemeral_1h_input_tokens') or 0 for r in reqs)
    five = sum((r['usage'].get('cache_creation') or {}).get('ephemeral_5m_input_tokens') or 0 for r in reqs)
    return '1h' if one_h >= five else '5m'

PLACEHOLDER_SYSTEM = [
    {'type': 'text', 'text': "You are Claude Code, Anthropic's official CLI for Claude."},
    {'type': 'text', 'text': '[backtest placeholder: Claude Code system prompt, part 1; not recorded by this Claude Code version]'},
    {'type': 'text', 'text': '[backtest placeholder: Claude Code system prompt, part 2; not recorded by this Claude Code version]'},
]
PLACEHOLDER_TOOLS = [{'name': 'BacktestPlaceholderTools', 'description': '[backtest placeholder: the tool list, not recorded by this Claude Code version]', 'input_schema': {'type': 'object', 'properties': {}}}]

def encode_messages(table, messages):
    out = []
    for m in messages:
        out.append([m['role'], [table.add(b) for b in _blocks(m['content'])]])
    return out

def attribute_tokens(session):
    """Give every block a token count. System + tools: from the first request's cache read when it read the
    cross-session system prefix, else from characters. Messages: each request's recorded prompt total minus
    what earlier requests already attributed is the measured size of its new blocks; an assistant message's
    blocks are sized from its response's recorded output_tokens (thinking gets what text and tool_use leave),
    the rest of the delta is spread over the request's other new blocks by characters."""
    reqs = session['requests']; table = BlockTable()
    ttl = ttl_of_session(reqs)
    session['ttl'] = ttl
    # encode
    for r in reqs:
        r['msgs_real'] = encode_messages(table, r['real_messages'])
        r['msgs_cont'] = encode_messages(table, r['cont_messages'])
        if r['system'] is None:
            r['sys_ids'] = [table.add(b) for b in PLACEHOLDER_SYSTEM]; r['tool_ids'] = [table.add(t) for t in PLACEHOLDER_TOOLS]
            r['placeholder_head'] = True
        else:
            r['sys_ids'] = [table.add(b) for b in r['system']]; r['tool_ids'] = [table.add(t) for t in r['tools']]
            r['placeholder_head'] = False
        r['resp_ids'] = [bid(b) for b in r['response']]
    # response output tokens by block
    out_by_block = {}
    for r in reqs:
        ids = r['resp_ids']
        if not ids: continue
        out_tok = r['usage'].get('output_tokens') or 0
        visible = [(i, b) for i, b in zip(ids, r['response']) if b.get('type') in ('text', 'tool_use')]
        vis_tok = {i: max(1, weight_chars(b) / DEFAULT_CHARS_PER_TOKEN) for i, b in visible}
        think = [i for i, b in zip(ids, r['response']) if b.get('type') in ('thinking', 'redacted_thinking')]
        rest = max(0.0, out_tok - sum(vis_tok.values()))
        for i in vis_tok: out_by_block[i] = vis_tok[i] if (rest > 0 or not think) else vis_tok[i] * out_tok / max(1, sum(vis_tok.values()))
        for i in think: out_by_block[i] = rest / len(think)
    # head (system + tools) size
    first = reqs[0]; T1 = recorded_total(first['usage']); R1 = first['usage'].get('cache_read_input_tokens') or 0
    head_tokens = {}
    def head_chars(r): return [len(table.raw[i]) for i in r['tool_ids']] + [len(table.raw[i]) for i in r['sys_ids']]
    def set_head(r, S):
        ch = head_chars(r); tot = sum(ch) or 1
        for i, c in zip(r['tool_ids'] + r['sys_ids'], ch):
            if i not in table.tokens: table.tokens[i] = S * c / tot; table.how[i] = 'head'
    msg_chars_1 = sum(len(table.raw[i]) for _, ids in first['msgs_real'] for i in ids)
    if first['placeholder_head']:
        S = R1 if 0 < R1 < T1 else max(0, T1 - msg_chars_1 / DEFAULT_CHARS_PER_TOKEN)
        session['head_source'] = 'first request cache read' if 0 < R1 < T1 else 'first request total minus characters/3.3'
    else:
        hc = sum(head_chars(first))
        S = R1 if (0 < R1 < T1 and 2.0 <= hc / R1 <= 6.0) else hc / DEFAULT_CHARS_PER_TOKEN
        session['head_source'] = 'first request cache read' if S == R1 else 'characters/3.3'
    session['head_tokens_first'] = S
    set_head(first, S)
    prev_head = None
    residuals = []; delta_ratio = []
    for r in reqs:
        # a changed head (exact sessions): new head blocks sized by characters at the ratio the first head had
        new_head = [i for i in r['tool_ids'] + r['sys_ids'] if i not in table.tokens]
        if new_head:
            known = [i for i in reqs[0]['tool_ids'] + reqs[0]['sys_ids']]
            ratio = sum(table.tokens[i] for i in known) / max(1, sum(len(table.raw[i]) for i in known))
            for i in new_head: table.tokens[i] = len(table.raw[i]) * ratio; table.how[i] = 'head-changed'
        T = recorded_total(r['usage'])
        occ = collections.Counter(i for _, ids in r['msgs_real'] for i in ids)
        head = sum(table.tokens[i] for i in r['tool_ids'] + r['sys_ids'])
        carried = sum(table.tokens[i] * n for i, n in occ.items() if i in table.tokens)
        new = [i for i in occ if i not in table.tokens]
        mass = T - head - carried
        fixed = {}
        for i in new:
            if i in out_by_block: fixed[i] = out_by_block[i]
        rest_ids = [i for i in new if i not in fixed]
        img = {i: 0 for i in rest_ids}
        wt = {}
        for i in rest_ids:
            b = json.loads(table.raw[i])
            w = weight_chars(b)
            n_img = images_in(b)
            wt[i] = (w or 0) / DEFAULT_CHARS_PER_TOKEN + n_img * IMAGE_TOKENS
        rest_mass = mass - sum(fixed[i] * occ[i] for i in fixed)
        wsum = sum(wt[i] * occ[i] for i in rest_ids)
        if rest_ids:
            if wsum > 0 and rest_mass > 0.25 * wsum:
                scale = rest_mass / wsum
                for i in rest_ids: table.tokens[i] = wt[i] * scale; table.how[i] = 'delta'
                delta_ratio.append((rest_mass, sum(weight_chars(json.loads(table.raw[i])) or 0 for i in rest_ids if not images_in(json.loads(table.raw[i])))))
            else:
                for i in rest_ids: table.tokens[i] = wt[i]; table.how[i] = 'chars (delta too small)'
        for i in fixed: table.tokens[i] = fixed[i]; table.how[i] = 'output_tokens'
        total = head + sum(table.tokens[i] * n for i, n in occ.items())
        r['residual'] = T - total
        residuals.append(r['residual'])
    # chars per token for text no recorded request carried (the gateway's timeline rows, continuation-only blocks):
    # the recorded head (tools + system, measured by the first request's cache read) when this session recorded it,
    # else HEAD_CHARS_PER_TOKEN_DEFAULT (the mean over the sessions that recorded it; see the report).
    if not first['placeholder_head'] and session['head_source'] == 'first request cache read':
        session['chars_per_token'] = sum(head_chars(first)) / S; session['cpt_source'] = 'this session\'s recorded head'
    else:
        session['chars_per_token'] = HEAD_CHARS_PER_TOKEN_DEFAULT; session['cpt_source'] = 'default (mean of recorded heads)'
    # continuation-only blocks (never in a recorded request): by characters
    cpt = session['chars_per_token']
    unrecorded = 0
    for r in reqs:
        for _, ids in r['msgs_cont']:
            for i in ids:
                if i not in table.tokens:
                    b = json.loads(table.raw[i])
                    table.tokens[i] = (weight_chars(b) or 0) / cpt + images_in(b) * IMAGE_TOKENS; table.how[i] = 'chars (continuation only)'; unrecorded += 1
    session['continuation_only_blocks'] = unrecorded
    session['table'] = table
    return session

def save(session, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    t = session['table']
    blocks = {i: {'raw': t.raw[i], 'tokens': t.tokens.get(i, 0.0), 'how': t.how.get(i), 'kind': t.kind[i]} for i in t.raw}
    reqs = []
    # per-request TTL of Claude Code's breakpoints, from what the request recorded writing (1h or 5m);
    # a request that wrote nothing keeps the previous one (sessions can switch mid-way, e.g. from 1h to 5m)
    ttl_now = session['ttl']
    for r in session['requests']:
        cc = r['usage'].get('cache_creation') or {}
        if (cc.get('ephemeral_1h_input_tokens') or 0) > 0: ttl_now = '1h'
        elif (cc.get('ephemeral_5m_input_tokens') or 0) > 0: ttl_now = '5m'
        r['ttl'] = ttl_now
    for k, r in enumerate(session['requests']):
        reqs.append(dict(i=k, message_id=r['message_id'], ts=r['ts'], ttl=r['ttl'], usage=r['usage'], model=r['model'], version=r['version'],
                         real_kind=r['real_kind'], cont_kind=r['cont_kind'], after_compaction=r['after_compaction'],
                         sys=r['sys_ids'], tools=r['tool_ids'], placeholder_head=r['placeholder_head'],
                         cache_control=r['cache_control'], params=r['params'],
                         msgs_real=r['msgs_real'], msgs_cont=r['msgs_cont'], deferred_tool_names=r.get('deferred_tool_names'), resp=r['resp_ids'], residual=r['residual']))
    meta = {k: v for k, v in session.items() if k not in ('requests', 'table')}
    json.dump(dict(meta=meta, blocks=blocks, requests=reqs), open(os.path.join(out_dir, 'session.json'), 'w'), ensure_ascii=False)

if __name__ == '__main__':
    sel = json.load(open(sys.argv[1])); out = sys.argv[2]
    only = set(sys.argv[3:])
    for s in sel:
        sid = os.path.basename(s['path'])[:-6]
        if only and sid[:8] not in only: continue
        sess = build_session(s['path'])
        attribute_tokens(sess)
        save(sess, os.path.join(out, sid[:8]))
        res = [abs(r['residual']) for r in sess['requests']]
        kinds = collections.Counter(r['real_kind'] for r in sess['requests'])
        print(sid[:8], sess['mode'], len(sess['requests']), dict(kinds), 'compactions', len(sess['compactions']), 'S=%.0f(%s)' % (sess['head_tokens_first'], sess['head_source']),
              'cpt=%.2f' % sess['chars_per_token'], 'ttl', sess['ttl'], 'mean|resid|=%.0f max=%.0f' % (sum(res) / len(res), max(res)), 'cont-only blocks', sess['continuation_only_blocks'], flush=True)
