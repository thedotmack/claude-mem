"""Exact request reconstruction from Claude Code's api-request / api-request-shape / api-request-blob entries
(versions >= 2.1.300). Message hash = sha256(json.dumps(message, sort_keys=True, separators=(',',':'), ensure_ascii=False)).
A request's messages = base request's messages[:keep] + tail (hashes resolved from blobs, else from transcript messages)."""
import json, hashlib, collections
def H(o): return hashlib.sha256(json.dumps(o, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()

def load(path):
    rows = []
    for line in open(path, errors='replace'):
        try: rows.append(json.loads(line))
        except Exception: pass
    return rows

def exact_requests(rows):
    blobs = {d['hash']: d['message'] for d in rows if d.get('type') == 'api-request-blob'}
    shapes = {d['shapeHash']: d['shape'] for d in rows if d.get('type') == 'api-request-shape'}
    byhash = dict(blobs)
    asst = collections.OrderedDict()
    for d in rows:
        if d.get('isSidechain'): continue
        if d.get('type') == 'assistant':
            m = d['message']; asst.setdefault(m['id'], []).extend(m['content'])
        if d.get('type') == 'user':
            m = d['message']; byhash.setdefault(H({'role': 'user', 'content': m['content']}), {'role': 'user', 'content': m['content']})
    for k, v in asst.items():
        msg = {'role': 'assistant', 'content': v}; byhash.setdefault(H(msg), msg)
    out = {}; order = []
    for line_no, d in enumerate(rows):
        if d.get('type') != 'api-request': continue
        base = out.get(d.get('base')) if d.get('base') else None
        if d.get('base') and base is None:
            msgs = None
        else:
            msgs = (base['messages'][:d['keep']] if base and base['messages'] is not None else []) 
            for h in d['tail']:
                if msgs is None: break
                msgs.append(byhash[h] if h in byhash else {'role': '?', 'content': [], '_unresolved': h})
        rec = dict(line_no=line_no, id=d['id'], timestamp=d['timestamp'], querySource=d.get('querySource'), shape=shapes.get(d['shapeHash']), shapeHash=d['shapeHash'],
                   params=d.get('params'), cacheControl=d.get('cacheControl'), messages=msgs, unresolved=[h for h in d['tail'] if h not in byhash])
        out[d['id']] = rec; order.append(rec)
    return order
