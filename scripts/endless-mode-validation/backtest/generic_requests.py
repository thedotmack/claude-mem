"""Generic request reconstruction from transcript entries (any Claude Code version): the chain of entries
from the root to the parent of each main-thread assistant message, turned into API messages."""
import json, re
WRAP = re.compile(r'^<system-reminder>\n?(.*?)\n?</system-reminder>$', re.S)

def _blocks(content):
    return [{'type': 'text', 'text': content}] if isinstance(content, str) else list(content)

def messages_of_chain(chain, results_by_call=None, before_ts=None):
    """Between two assistant messages, Claude Code (>= 2.1.300, checked against api-request records) sends one user
    message (tool results, then user-role attachments, then the user's own blocks) and then one system message
    (every system-role attachment, unwrapped, joined by a blank line)."""
    msgs = []
    run = None
    cur_asst = None
    def flush():
        nonlocal run
        # Parallel tool calls: each result entry's parent is its own tool_use entry, so the chain to the leaf
        # holds only one branch's result. The request carries them all: add the missing ones (in call order).
        if cur_asst is not None and results_by_call is not None:
            calls = [b.get('id') for b in cur_asst['content'] if b.get('type') == 'tool_use']
            have = {b.get('tool_use_id') for b in (run['results'] if run else [])}
            missing = [c for c in calls if c not in have and c in results_by_call and (before_ts is None or results_by_call[c][0] < before_ts)]
            if missing:
                if run is None: run = {'results': [], 'att_user': [], 'own': [], 'att_sys': []}
                run['results'].extend(results_by_call[c][1] for c in missing)
                order = {c: k for k, c in enumerate(calls)}
                run['results'].sort(key=lambda b: order.get(b.get('tool_use_id'), len(order)))
        if run is None: return
        user = run['results'] + run['att_user'] + run['own']
        if user: msgs.append({'role': 'user', 'content': user})
        if run['att_sys']: msgs.append({'role': 'system', 'content': [{'type': 'text', 'text': '\n\n'.join(run['att_sys'])}]})
        run = None
    for d in chain:
        t = d.get('type')
        if t == 'assistant':
            m = d['message']
            # One response is written as one entry per content block; with parallel tool calls each tool_use
            # entry is followed by its tool_result entry. The API request holds the response as one message
            # and all the results as the next user message, so a later entry of the same response joins it.
            if cur_asst is not None and cur_asst.get('_id') == m.get('id'):
                cur_asst['content'].extend(m['content'])
                continue
            flush()
            cur_asst = {'role': 'assistant', 'content': list(m['content']), '_id': m.get('id')}
            msgs.append(cur_asst)
            continue
        if t not in ('user', 'attachment'): continue
        if t == 'attachment' and not d.get('rendered'): continue
        if run is None: run = {'results': [], 'att_user': [], 'own': [], 'att_sys': []}
        if t == 'user':
            for b in _blocks(d['message']['content']):
                (run['results'] if b.get('type') == 'tool_result' else run['own']).append(b)
        else:
            role = d.get('renderedRole') or 'user'
            texts = [r.get('content', '') for r in d['rendered'] if isinstance(r, dict)]
            if role == 'system': run['att_sys'].extend(WRAP.sub(r'\1', x) for x in texts)
            else: run['att_user'].extend({'type': 'text', 'text': x} for x in texts)
    flush()
    for m in msgs: m.pop('_id', None)
    return msgs

def generic_requests(rows):
    """One record per main-thread API request (assistant message id), in order."""
    byuuid = {d['uuid']: d for d in rows if d.get('uuid')}
    seen = set(); out = []
    groups = {}
    for d in rows:
        if d.get('type') == 'assistant' and not d.get('isSidechain'):
            m = d.get('message') or {}
            if m.get('model') == '<synthetic>' or not m.get('usage'): continue
            groups.setdefault(m['id'], []).append(d)
    for d in rows:
        if d.get('type') != 'assistant' or d.get('isSidechain'): continue
        m = d.get('message') or {}
        mid = m.get('id')
        if mid not in groups or mid in seen: continue
        seen.add(mid)
        first = groups[mid][0]; last = groups[mid][-1]
        chain = []; u = first.get('parentUuid'); guard = 0
        while u and u in byuuid and guard < 200000:
            e = byuuid[u]; chain.append(e)
            u = e.get('parentUuid') or (e.get('logicalParentUuid') if False else None); guard += 1
        chain.reverse()
        out.append(dict(message_id=mid, timestamp=first['timestamp'], usage=last['message']['usage'], model=m.get('model'),
                        chain_uuids=[e['uuid'] for e in chain], messages=messages_of_chain(chain), response_entries=[g['uuid'] for g in groups[mid]],
                        response_content=[b for g in groups[mid] for b in g['message']['content']], request_id=first.get('requestId')))
    return out
