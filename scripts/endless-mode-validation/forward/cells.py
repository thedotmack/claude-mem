"""The page's cells for one agent's run: agent cost at the frozen card plus observer cost, read at fixed turns.

Usage: python3 cells.py <run dir> <agent> --project <name> --card <card.json> [--turns 100,200,300] [--out <file>]
Writes one record per setup per turn, and prints a reconcile line per stack (agent billed + observer billed).

  cell(agent, setup, N) = sum over agent requests in turns 1..N of (uncached x input + cached x cache_read + output x output) / 1e6
                        + sum over observer calls logged before "turn N done" of the observer's billed cost

A cell fills only when "turn N done" is in the session log; nothing is extrapolated.

Observer cost is the worker log's costUSD / 2. The log adds usage.cost and upstream_inference_cost, which OpenRouter
reports as equal, so it reads double (OpenRouterProvider.ts). That bug is left in place on purpose here; the batch
reconcile against the key's spend (billed totals printed here, compared with the key by whoever runs the batch) catches it if it is ever fixed.

The observer's cached split comes from the log's cachedTokens where the worker logs it (this checkout: `measured`).
The published release does not log it, so its split is worked out from cost and the card (`derived`).
"""
import argparse, datetime, glob, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SETUPS = {'none': 'alone', 'release': 'standard', 'timeline': 'endless'}
# Billed vs card, and the batch vs the key's spend, must agree within this. Reason: on one pinned endpoint at one price
# they should match; the plan's reconciles measured gaps of 0.05% and 0.10%, and 1% allows rounding and billing lag.
RECONCILE_TOLERANCE = 0.01
OBSERVER_LINE = re.compile(r'^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\.\d+\] .*OpenRouter API usage \{(.*)\}\s*$')


def observer_calls(stack):
    """Every observer call in the stack's worker logs, oldest first, timed in UTC (the log uses local time)."""
    calls = []
    for path in sorted(glob.glob(os.path.join(stack, 'data', 'logs', '*.log'))):
        for line in open(path, errors='replace'):
            m = OBSERVER_LINE.match(line)
            if not m: continue
            fields = dict(part.split('=', 1) for part in m.group(2).split(', ') if '=' in part)
            logged = fields.get('costUSD')
            if logged is None: sys.exit(f'{path}: an observer call logged no cost, so the cell would be wrong: {line[:200]}')
            at = datetime.datetime.strptime(m.group(1), '%Y-%m-%d %H:%M:%S').astimezone(datetime.timezone.utc)
            calls.append(dict(at=at, input=int(fields.get('inputTokens', 0)), output=int(fields.get('outputTokens', 0)),
                              cached=int(fields['cachedTokens']) if 'cachedTokens' in fields else None,
                              model=fields.get('model'), billed=float(logged) / 2))
    return sorted(calls, key=lambda c: c['at'])


def observer_totals(calls, card):
    input_tokens = sum(c['input'] for c in calls); output = sum(c['output'] for c in calls); billed = sum(c['billed'] for c in calls)
    measured = bool(calls) and all(c['cached'] is not None for c in calls)
    if measured:
        cached = sum(c['cached'] for c in calls); source = 'measured'
    else:
        # billed = ((input - cached) x input price + cached x cache price + output x output price) / 1e6
        full_price = input_tokens * card['input'] + output * card['output']
        cached = round((full_price - billed * 1e6) / (card['input'] - card['cache_read'])) if calls else 0
        cached = max(0, min(cached, input_tokens)); source = 'derived' if calls else 'none'
    card_usd = ((input_tokens - cached) * card['input'] + cached * card['cache_read'] + output * card['output']) / 1e6
    return dict(calls=len(calls), input=input_tokens, cached=cached, cached_source=source, output=output, billed_usd=round(billed, 6),
                card_usd=round(card_usd, 6), models=sorted({c['model'] for c in calls if c['model']}))


def done_times(session_log):
    return {int(m.group(2)): datetime.datetime.strptime(m.group(1), '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
            for m in re.finditer(r'^(\S+Z) turn (\d+) done', session_log, re.M)}


def cell(stats, calls, card, done, turn):
    if turn not in done: return dict(label='not run')
    rows = [v for k, v in stats['per_turn'].items() if int(k) <= turn]
    agent = {key: sum(r[key] for r in rows) for key in ('requests', 'uncached', 'cached', 'output')}
    agent_card = (agent['uncached'] * card['input'] + agent['cached'] * card['cache_read'] + agent['output'] * card['output']) / 1e6
    observer = observer_totals([c for c in calls if c['at'] <= done[turn]], card)
    return dict(label='measured', agent_tokens=agent, agent_usd=round(agent_card, 6), agent_billed_usd=round(sum(r['measured'] for r in rows), 6),
                observer_tokens=observer, observer_usd=observer['billed_usd'], total_usd=round(agent_card + observer['billed_usd'], 6))


def read_text(path):
    return open(path).read().strip() if os.path.exists(path) else None


def line_count(path):
    return sum(1 for _ in open(path)) if os.path.exists(path) else 0


def stack_records(run_dir, config, args, card):
    stack = os.path.join(run_dir, 'stacks', config)
    log = open(os.path.join(stack, 'logs', 'session.log')).read()
    stats = json.loads(subprocess.run([sys.executable, os.path.join(HERE, 'stats.py'), stack, args.card], check=True, capture_output=True, text=True).stdout)
    calls = observer_calls(stack); done = done_times(log)
    agent_billed = stats['measured_cost_usd'] or 0
    health = dict(errors=len(stats['errors']), spoiled_turns=sorted(map(int, stats['spoiled_turns'])), observer_wait_capped_turns=stats['observer_wait_capped_turns'],
                  observations_stored=stats['observations_stored'], summaries_stored=stats['summaries_stored'], memory_tools_seen=stats['memory_tools_seen'],
                  timeline_blocks_at_end=(stats['timeline_end'] or {}).get('blocks'), requests=stats['requests'], requests_outside_session=stats['requests_outside_session'],
                  rate_limit_429_attempts=sum(line_count(os.path.join(stack, d, '429s.tsv')) for d in ('tee-anthropic', 'tee-codex')),
                  off_pin=any(os.path.exists(os.path.join(stack, d, 'OFF-PIN')) for d in ('tee-anthropic', 'tee-codex')),
                  # Codex only: answers whose provider was confirmed by lookup. Fewer than `requests` means some are unproven.
                  generation_lookups=line_count(os.path.join(stack, 'tee-codex', 'generation-lookups.tsv')))
    records = [dict(project=args.project, agent=args.agent, setup=SETUPS[config], config=config, turn=turn, provider=card['provider_slug'], model=card['model'],
                    agent_version=read_text(os.path.join(stack, 'agent-version.txt')), claude_mem_version=read_text(os.path.join(stack, 'release-version.txt')) or 'this checkout',
                    work=None, health=health, **cell(stats, calls, card, done, turn)) for turn in args.turns]
    gap = (agent_billed - stats['total_cost_usd']) / stats['total_cost_usd'] if stats['total_cost_usd'] else 0
    observer = observer_totals(calls, card)
    print(f"{args.agent}/{config}: turns done {max(done, default=0)}; agent billed ${agent_billed:.6f}, agent at card ${stats['total_cost_usd']:.6f} ({gap:+.2%}{' DRIFT' if abs(gap) > RECONCILE_TOLERANCE else ''}); "
          f"observer billed ${observer['billed_usd']:.6f} over {observer['calls']} calls, at card ${observer['card_usd']:.6f} (cached {observer['cached_source']}); "
          f"observations {stats['observations_stored']}, summaries {stats['summaries_stored']}; memory tools {len(stats['memory_tools_seen'])}; timeline blocks {health['timeline_blocks_at_end']}; "
          f"cache hit {stats['cache_read'] / max(1, stats['cache_read'] + stats['uncached_input']):.1%}; off-pin {health['off_pin']}; provider lookups {health['generation_lookups']}; 429 attempts {health['rate_limit_429_attempts']}")
    return records, agent_billed + observer['billed_usd']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir'); ap.add_argument('agent'); ap.add_argument('--project', required=True); ap.add_argument('--card', required=True)
    ap.add_argument('--turns', default='100,200,300', type=lambda text: [int(x) for x in text.split(',')]); ap.add_argument('--out')
    args = ap.parse_args()
    card = json.load(open(args.card))
    records, billed = [], 0.0
    for config in SETUPS:
        if not os.path.isdir(os.path.join(args.run_dir, 'stacks', config)): continue
        stack_cells, stack_billed = stack_records(args.run_dir, config, args, card)
        records += stack_cells; billed += stack_billed
    if not records: sys.exit(f'no stacks for {list(SETUPS)} in {args.run_dir}')
    print(f'{args.agent}: billed total ${billed:.6f}')
    if args.out:
        doc = []
        if os.path.exists(args.out): doc = [r for r in json.load(open(args.out)) if not (r['agent'] == args.agent and r['project'] == args.project)]
        json.dump(doc + records, open(args.out, 'w'), indent=1)


if __name__ == '__main__':
    main()
