"""Stats for one configuration's session, from its tee (extracted.jsonl from extract.py, plus the saved responses).
Usage: python3 stats.py <stack dir> <prices file> [<netwatch log>]   (prints one JSON object)

Definitions (the same as in our reports):
- requests: the session's requests that got an answer with usage (Anthropic: the session id in metadata.user_id;
  Codex: the thread id as prompt_cache_key). Requests are assigned to turns by the session log's turn start times.
- tool_calls: every tool call seen in any request, deduplicated by call id; file_reads: Read calls and shell commands
  that print a file; file_rereads: reads of a file after its first.
- cost: from the provider's own usage on every request, at the prices file's per-MTok prices. Where the provider
  itself reports a cost per request (OpenRouter's usage.cost), measured_cost_usd sums it, with the count of requests
  that carried one.
- compactions: Claude Code's summarizing request, and the first request continued from its summary, with the
  requests just before and after.
- errors: requests with no answer, a non-200 answer or an error event. A turn is spoiled when it has one, or a
  netwatch probe of its provider failed inside it.
"""
import glob, json, os, re, sys

S, prices_file = sys.argv[1], sys.argv[2]
netwatch = sys.argv[3] if len(sys.argv) > 3 else None
P = json.load(open(prices_file))
log = open(os.path.join(S, 'logs', 'session.log')).read()
sid = open(os.path.join(S, 'logs', 'session.sid')).read().strip()
starts = [(m.group(1), int(m.group(2))) for m in re.finditer(r'^(\S+Z) turn (\d+) start', log, re.M)]
dones = {int(m.group(2)): m.group(1) for m in re.finditer(r'^(\S+Z) turn (\d+) done', log, re.M)}
turn_rc = {}
for m in re.finditer(r'^(\S+Z) turn (\d+) start\n(?:turn-retry:[^\n]*\n)?rc=(\S+) secs=(\S+) error=(\S+)', log, re.M):
    turn_rc[int(m.group(2))] = dict(rc=m.group(3), secs=int(m.group(4)), error=m.group(5) not in ('False', 'None'))
retried_turns = sorted({int(m.group(1)) for m in re.finditer(r'turn (\d+) start\nturn-retry:', log)})

def turn_of(iso):
    c = [n for s, n in starts if s <= iso]
    return max(c) if c else 0

def price(key):
    v = P.get(key)
    return 0.0 if v is None else v

recs, status_by = [], {}
tee_dirs = [d for d in (os.path.join(S, 'tee-anthropic'), os.path.join(S, 'tee-codex')) if os.path.isdir(d)]
unextracted = 0
for d in tee_dirs:
    if os.path.exists(os.path.join(d, 'index.tsv')):
        for line in open(os.path.join(d, 'index.tsv')):
            p = line.rstrip('\n').split('\t')
            if len(p) >= 4: status_by[(d, p[0])] = p[3]
    if os.path.exists(os.path.join(d, 'extracted.jsonl')):
        by_n = {}
        for l in open(os.path.join(d, 'extracted.jsonl')):
            r = json.loads(l); r['dir'] = d; by_n[r['n']] = r
        recs += sorted(by_n.values(), key=lambda r: r['n'])
    unextracted += len([f for f in os.listdir(d) if f.endswith('-req.body')])
recs = [r for r in recs if (sid in r['conversation'] if r['proto'] == 'anthropic' else r['conversation'] == sid)]

reads, seen, reqs, errors = {}, set(), [], []
measured = dict(usd=0.0, requests=0)
for r in recs:
    for c in r['tool_uses']:
        if c['id'] in seen: continue
        seen.add(c['id'])
        for f in c['read_files']: reads[f] = reads.get(f, 0) + 1
    turn = turn_of(r['time'])
    rp = os.path.join(r['dir'], f"{r['n']}-resp.raw"); status = status_by.get((r['dir'], r['n']), '?')
    if not os.path.exists(rp) or status != '200':
        errors.append(dict(n=r['n'], turn=turn, status=status)); continue
    u, out, err, cost_reported = {}, 0, None, None
    for line in open(rp, errors='replace'):
        if not line.startswith('data: '): continue
        try: ev = json.loads(line[6:])
        except Exception: continue
        t = ev.get('type')
        if t in ('error', 'response.failed'): err = json.dumps(ev)[:200]
        if t == 'message_start': u = dict(ev['message'].get('usage') or {})
        if t == 'message_delta':
            du = ev.get('usage') or {}; out = du.get('output_tokens', out)
            for k in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'):
                if du.get(k): u[k] = du[k]
            if isinstance(du.get('cost'), (int, float)): cost_reported = du['cost']
        if t == 'response.completed':
            u = ev['response'].get('usage') or {}; out = u.get('output_tokens', 0)
        if isinstance(u.get('cost'), (int, float)): cost_reported = u['cost']
    if err: errors.append(dict(n=r['n'], turn=turn, error=err)); continue
    if r['proto'] == 'anthropic':
        cc = u.get('cache_creation') or {}
        w5 = cc.get('ephemeral_5m_input_tokens', 0); w1 = cc.get('ephemeral_1h_input_tokens', 0)
        if not cc and u.get('cache_creation_input_tokens'): w5 = u['cache_creation_input_tokens']
        inp = u.get('input_tokens', 0); rd = u.get('cache_read_input_tokens', 0)
    else:
        total_in = u.get('input_tokens', 0); rd = (u.get('input_tokens_details') or {}).get('cached_tokens', 0)
        inp = total_in - rd; w5 = w1 = 0
    cost = (inp * price('input') + w5 * price('cache_write_5m') + w1 * price('cache_write_1h') + rd * price('cache_read') + out * price('output')) / 1e6
    if cost_reported is not None: measured['usd'] += cost_reported; measured['requests'] += 1
    reqs.append(dict(n=r['n'], turn=turn, inp=inp, read=rd, w5=w5, w1=w1, out=out, size=inp + rd + w5 + w1, cost=cost, kind=r['kind'],
                     timeline_blocks=r['timeline_blocks'], timeline_chars=r['timeline_chars']))

cum = 0
for r in reqs: cum += r['cost']; r['cum'] = cum
compactions, seen_continued = [], False
for i, r in enumerate(reqs):
    if r['kind'] == 'summarizing request' or (r['kind'] == 'continued from a summary' and not seen_continued):
        if r['kind'] == 'continued from a summary': seen_continued = True
        b = reqs[i - 1] if i else None; a = reqs[i + 1] if i + 1 < len(reqs) else None
        compactions.append(dict(n=r['n'], turn=r['turn'], kind=r['kind'], prompt=r['size'], cost=round(r['cost'], 4),
                                prompt_before=b and b['size'], cost_before=b and round(b['cost'], 4), cumulative_cost_before=b and round(b['cum'], 4),
                                prompt_after=a and a['size'], cost_after=a and round(a['cost'], 4)))
per_turn = {}
for r in reqs:
    t = per_turn.setdefault(r['turn'], dict(requests=0, cost=0.0, prompt=0))
    t['requests'] += 1; t['cost'] += r['cost']; t['prompt'] = r['size']

# Spoiled turns: an unanswered/failed request, or a failed probe of this provider inside the turn.
probe_key = 'chatgpt=' if any(r['proto'] == 'responses' for r in recs) else ('openrouter=' if 'openrouter' in (P.get('source') or '') else 'anthropic=')
probe_fail = []
if netwatch and os.path.exists(netwatch):
    for l in open(netwatch):
        m = re.search(probe_key + r'(\d+)', l)
        if m and m.group(1) == '000': probe_fail.append(l.split()[0])
spoiled = {}
for s, n in starts:
    e = dones.get(n, '9999')
    bad = sum(1 for t in probe_fail if s <= t <= e); errs = sum(1 for x in errors if x['turn'] == n)
    if bad or errs or turn_rc.get(n, {}).get('error'):
        spoiled[n] = dict(netwatch_failures=bad, request_errors=errs, turn_error=turn_rc.get(n, {}).get('error', False))

rereads = sum(v - 1 for v in reads.values() if v > 1)
res = dict(stack=os.path.basename(S), turns=max(per_turn) if per_turn else 0, turns_started=len(starts), requests=len(reqs),
           output_tokens=sum(r['out'] for r in reqs), final_prompt_tokens=reqs[-1]['size'] if reqs else 0,
           max_prompt_tokens=max((r['size'] for r in reqs), default=0), tool_calls=len(seen), file_reads=sum(reads.values()), file_rereads=rereads,
           cache_read=sum(r['read'] for r in reqs), cache_write=sum(r['w5'] + r['w1'] for r in reqs), uncached_input=sum(r['inp'] for r in reqs),
           input_cost_usd=round(sum((r['inp'] * price('input') + r['w5'] * price('cache_write_5m') + r['w1'] * price('cache_write_1h') + r['read'] * price('cache_read')) / 1e6 for r in reqs), 4),
           output_cost_usd=round(sum(r['out'] for r in reqs) * price('output') / 1e6, 4))
res['total_cost_usd'] = round(res['input_cost_usd'] + res['output_cost_usd'], 4)
res['measured_cost_usd'] = round(measured['usd'], 6) if measured['requests'] else None
res['measured_cost_requests'] = measured['requests']
res['prices'] = dict(file=os.path.basename(prices_file), source=P.get('source'))
last = reqs[-1] if reqs else None
res['timeline_end'] = dict(blocks=last['timeline_blocks'], chars=last['timeline_chars'], est_tokens=last['timeline_chars'] // 4) if last else None
res['per_turn'] = {k: dict(requests=v['requests'], cost=round(v['cost'], 5), prompt=v['prompt']) for k, v in sorted(per_turn.items())}
res['compactions'] = compactions; res['errors'] = errors; res['spoiled_turns'] = spoiled; res['retried_turns'] = retried_turns
res['unextracted_bodies'] = unextracted
# Observer health: turns whose observer wait hit session.sh's cap, and quota pauses in the worker's log. Either one
# means fewer observations existed when Endless Mode folded, which makes its numbers worse, not better.
res['observer_wait_capped_turns'] = sorted(int(m.group(1)) for m in re.finditer(r'turn (\d+) done; observer wait 240s', log))
quota_pauses = 0
for lf in glob.glob(os.path.join(S, 'data', 'logs', '*.log')):
    quota_pauses += sum(1 for l in open(lf, errors='replace') if 'paused for quota' in l)
res['observer_quota_pauses'] = quota_pauses
print(json.dumps(res))
