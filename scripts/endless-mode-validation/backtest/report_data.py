"""Collect everything the tables need into report-data.json, and a per-request CSV per session (labelled sNN).
Usage: python3 report_data.py <sessions dir> <labels.json> <out dir>
"""
import json, os, sys, glob, collections, csv, re
sys.path.insert(0, os.path.dirname(__file__))

def user_prompts(path):
    """User turns as you typed them: main-thread user entries with their own text (not tool results,
    not meta, not compaction summaries, not task notifications)."""
    n = 0
    for line in open(path, errors='replace'):
        if '"type":"user"' not in line and '"type": "user"' not in line: continue
        try: d = json.loads(line)
        except Exception: continue
        if d.get('type') != 'user' or d.get('isSidechain') or d.get('isMeta') or d.get('isCompactSummary'): continue
        c = d['message']['content']
        texts = [c] if isinstance(c, str) else [b.get('text', '') for b in c if b.get('type') == 'text']
        if any(b.get('type') == 'tool_result' for b in (c if isinstance(c, list) else [])): continue
        t = ' '.join(texts).strip()
        if not t or t.startswith(('<task-notification>', '<local-command', '<command-name>', '<bash-', 'Caveat:', '[Request interrupted')): continue
        n += 1
    return n

def summarize(rows):
    if not rows: return None
    return dict(cost=sum(x['cost'] for x in rows), read=sum(x['read'] for x in rows), write=sum(x['write_1h'] + x['write_5m'] for x in rows),
                write_1h=sum(x['write_1h'] for x in rows), write_5m=sum(x['write_5m'] for x in rows), uncached=sum(x['uncached'] for x in rows),
                prompt=sum(x['prompt'] for x in rows), output=sum(x['output'] for x in rows),
                breaks=sum(1 for x in rows if x.get('brk')), peak=max(x['prompt'] for x in rows), final=rows[-1]['prompt'],
                break_where=collections.Counter(re.sub(r'\[\d+\]', '[i]', x['brk']) for x in rows if x.get('brk')).most_common(4))

def main(sdir_root, labels_file, out_dir):
    labels = json.load(open(labels_file))
    os.makedirs(out_dir, exist_ok=True)
    obs_summary = json.load(open(os.path.join(sdir_root, 'observations-summary.json')))
    data = []
    for d in sorted(glob.glob(os.path.join(sdir_root, '*', 'sim.json'))):
        sdir = os.path.dirname(d); sid8 = os.path.basename(sdir)
        sess = json.load(open(os.path.join(sdir, 'session.json'))); sim = json.load(open(d))
        meta = sess['meta']; reqs = sess['requests']
        rec = sim['recorded']; a = sim['a']
        # validation of (a)
        within = sum(1 for x, y in zip(a, rec) if abs(x['read'] - y['read']) <= max(0.02 * y['prompt'], 500))
        within_w = sum(1 for x, y in zip(a, rec) if abs((x['write_1h'] + x['write_5m']) - (y['write_1h'] + y['write_5m'])) <= max(0.02 * y['prompt'], 500))
        mism = [dict(i=k, ts=reqs[k]['ts'], prompt=y['prompt'], rec_read=y['read'], sim_read=round(x['read']), rec_write=y['write_1h'] + y['write_5m'], sim_write=round(x['write_1h'] + x['write_5m']), sim_break=x.get('brk'))
                for k, (x, y) in enumerate(zip(a, rec)) if abs(x['read'] - y['read']) > max(0.02 * y['prompt'], 500)]
        # observations / mapping
        obs = json.load(open(os.path.join(sdir, 'observations.json'))) if os.path.exists(os.path.join(sdir, 'observations.json')) else {}
        blocks = sess['blocks']
        calls = []
        for r in reqs:
            for i in r['resp']:
                b = blocks.get(i)
                if b and b['kind'] == 'tool_use': calls.append(json.loads(b['raw']).get('id'))
        calls = list(dict.fromkeys(calls))
        with_obs = sum(1 for c in calls if c in obs)
        # gateway meta
        gw = {}
        for mode, fmt, suf in (('b', 'timeline', ''), ('c', 'observation', ''), ('b_real', 'timeline', '-real'), ('c_real', 'observation', '-real')):
            p = os.path.join(sdir, f'gateway-{fmt}{suf}.json')
            if not os.path.exists(p): continue
            g = json.load(open(p))
            ledger_dir = g['ledger_directory']; entries = []
            for f in glob.glob(os.path.join(ledger_dir, '*.jsonl')):
                entries += [json.loads(l) for l in open(f)]
            folds = [e for e in entries if e.get('type') == 'timelineFold' and e.get('sequence', 0) > 0]
            gw[mode] = dict(requests_without_timeline=g['requests_without_timeline'], turn_starts=sum(1 for x in g['requests'] if x['turn'] > 0 and not x['within_turn']),
                            max_turn=max([x['turn'] for x in g['requests']] or [0]), folds=len(folds), rows=sum(len(e['rows']) for e in folds),
                            observation_rows=sum(len(e['observationIds']) for e in folds), whole_turn_folds=sum(1 for e in folds if e['throughCallId'] is None),
                            culled_tokens_est=sum(e['culledTokensEst'] for e in folds), suspended=[e for e in entries if e.get('type') == 'suspended'],
                            thinking_cuts=sum(1 for e in entries if e.get('type') == 'thinkingCut'), header=[e.get('text') is not None for e in entries if e.get('type') == 'header'],
                            first_no_timeline=next((x['i'] for x in g['requests'] if not x['has_timeline']), None))
        def thinking_tokens(msgs, extra=None):
            return sum(blocks[i]['tokens'] for _, ids in msgs for i in ids if i in blocks and blocks[i]['kind'] in ('thinking', 'redacted_thinking'))
        think = {'cont_final': thinking_tokens(reqs[-1]['msgs_cont'])}
        gfile = os.path.join(sdir, 'gateway-timeline.json')
        if os.path.exists(gfile):
            gl = json.load(open(gfile))['requests'][-1]
            think['b_final'] = thinking_tokens(gl['msgs'])
        o = json.load(open(os.path.join(sdir, 'o.json'))) if os.path.exists(os.path.join(sdir, 'o.json')) else None
        entry = dict(sid=sid8, label=labels.get(sid8, sid8), session_id=meta['session_id'], mode=meta['mode'], requests=len(reqs), user_prompts=user_prompts(meta['path']),
                     compactions=meta['compactions'], compaction_requests=[k for k, r in enumerate(reqs) if r['after_compaction'] and (k == 0 or not reqs[k - 1]['after_compaction'])],
                     first_ts=reqs[0]['ts'], last_ts=reqs[-1]['ts'], model=collections.Counter(r['model'] for r in reqs).most_common(1)[0][0],
                     versions=sorted(set(r['version'] for r in reqs if r['version'])), real_kinds=dict(collections.Counter(r['real_kind'] for r in reqs)),
                     cont_kinds=dict(collections.Counter(r['cont_kind'] for r in reqs)), head_tokens=meta['head_tokens_first'], head_source=meta['head_source'],
                     chars_per_token=meta['chars_per_token'], cpt_source=meta.get('cpt_source'), max_abs_residual=max(abs(r['residual']) for r in reqs),
                     validation=dict(read_within=within, write_within=within_w, n=len(reqs), rec_read=sum(y['read'] for y in rec), sim_read=sum(x['read'] for x in a),
                                     rec_write=sum(y['write_1h'] + y['write_5m'] for y in rec), sim_write=sum(x['write_1h'] + x['write_5m'] for x in a),
                                     rec_cost=sum(y['cost'] for y in rec), sim_cost=sum(x['cost'] for x in a), mismatches=mism[:12], n_mismatch=len(mism)),
                     mapping=dict(main_thread_calls=len(calls), calls_with_observation=with_obs, **obs_summary.get(sid8, {})),
                     o_removed=(o or {}).get('removed_tokens'), thinking=think, o_strings=(o or {}).get('claude_mem_strings'),
                     summary={m: summarize(sim.get(m)) for m in ('recorded', 'o', 'a', 'b', 'c', 'b_real', 'c_real') if m in sim}, gateway=gw)
        data.append(entry)
        # per-request CSV for every session (the report quotes the 3 longest)
        with open(os.path.join(out_dir, f"requests-{labels.get(sid8, sid8)}.csv"), 'w', newline='') as fh:
            w = csv.writer(fh)
            w.writerow(['request', 'timestamp', 'recorded_prompt_tokens', 'o_prompt_tokens', 'a_prompt_tokens', 'b_prompt_tokens', 'c_prompt_tokens',
                        'recorded_running_cost_usd', 'o_running_cost_usd', 'a_running_cost_usd', 'b_running_cost_usd', 'c_running_cost_usd',
                        'a_cache_break', 'b_cache_break', 'c_cache_break'])
            run = collections.defaultdict(float)
            for k, r in enumerate(reqs):
                row = [k, r['ts']]
                for m in ('recorded', 'o', 'a', 'b', 'c'):
                    row.append(round(sim[m][k]['prompt']) if m in sim else '')
                for m in ('recorded', 'o', 'a', 'b', 'c'):
                    if m in sim: run[m] += sim[m][k]['cost']
                    row.append(round(run[m], 4) if m in sim else '')
                for m in ('a', 'b', 'c'):
                    row.append((sim[m][k].get('brk') or '') if m in sim else '')
                w.writerow(row)
        print(labels.get(sid8, sid8), 'ok', flush=True)
    json.dump(data, open(os.path.join(out_dir, 'report-data.json'), 'w'), indent=1, default=str)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3])
