#!/usr/bin/env python3
"""Plain-words tables from a task-benchmark SQLite file (run_session.py + extract.py). Numbers only; no commentary.

Every number says what it computes:
  - "whole session" numbers are cumulative: summed over every request of the session.
  - "per request" numbers are about one request (for example the largest prompt one request sent).
Arms are reported as the mean over their runs, with the lowest and highest run in brackets. Only finished, valid runs
count (a run marked invalid or never finished is listed and left out), and every counted run must share the same model,
tries and exercises: the labels (exercise count, prices) come from those settings.

Usage: report.py --db FILE [--out report.md]
"""
import argparse
import sqlite3
import statistics
import sys

from extract import PRICES, price_of


def run_metrics(db, run_id):
    m = {}
    exercises = db.execute('SELECT exercises FROM runs WHERE run_id=?', (run_id,)).fetchone()[0].split(',')
    final = {}
    first = {}
    for ex, attempt, passed, tp, tt, rule in db.execute(
            "SELECT exercise, attempt, passed, tests_passed, tests_total, rule_kept FROM turns "
            "WHERE run_id=? AND kind='task' ORDER BY turn_no", (run_id,)):
        if attempt == 1:
            first[ex] = passed
        final[ex] = (passed, tp, tt, rule)
    m['exercises'] = len(exercises)
    m['exercises_run'] = len(final)
    m['solved'] = sum(1 for v in final.values() if v[0])
    m['solved_first_try'] = sum(1 for v in first.values() if v)
    m['tests_passed'] = sum(v[1] for v in final.values())
    m['tests_total'] = sum(v[2] for v in final.values())
    m['rule_kept'] = sum(1 for v in final.values() if v[3])
    row = db.execute("SELECT count(*), sum(elapsed_s), sum(is_error), sum(retried) FROM turns WHERE run_id=?",
                     (run_id,)).fetchone()
    m['turns'], m['elapsed_min'], m['error_turns'], m['retried_turns'] = row[0], (row[1] or 0) / 60, row[2], row[3]
    m['median_turn_s'] = statistics.median(r[0] for r in db.execute(
        "SELECT elapsed_s FROM turns WHERE run_id=? AND kind='task'", (run_id,)))
    for source in ('agent', 'observer'):
        r = db.execute('SELECT count(*), coalesce(sum(cost_usd),0), coalesce(sum(cost_opus55_usd),0), '
                       'coalesce(sum(prompt_tokens),0), coalesce(sum(output_tokens),0), coalesce(max(prompt_tokens),0), '
                       'coalesce(sum(long_prompt),0), coalesce(sum(cache_read),0) '
                       'FROM requests WHERE run_id=? AND source=? AND status=200', (run_id, source)).fetchone()
        (m[f'{source}_requests'], m[f'{source}_cost'], m[f'{source}_cost_opus'], m[f'{source}_prompt_tokens'],
         m[f'{source}_output_tokens'], m[f'{source}_max_prompt'], m[f'{source}_long_requests'],
         m[f'{source}_cache_read']) = r
    m['failed_requests'] = db.execute('SELECT count(*) FROM requests WHERE run_id=? AND status!=200',
                                      (run_id,)).fetchone()[0]
    columns = [row[1] for row in db.execute('PRAGMA table_info(requests)')]
    m['incomplete_requests'] = db.execute('SELECT count(*) FROM requests WHERE run_id=? AND complete=0',
                                          (run_id,)).fetchone()[0] if 'complete' in columns else 0
    m['total_cost'] = m['agent_cost'] + m['observer_cost']
    m['total_cost_opus'] = m['agent_cost_opus'] + m['observer_cost']  # the observer stays on its own model
    # Prompt size of the last agent request of each exercise's first try, in exercise order (per request, not summed).
    m['prompt_by_exercise'] = [r[0] for r in db.execute(
        "SELECT (SELECT prompt_tokens FROM requests q WHERE q.run_id=t.run_id AND q.source='agent' "
        "AND q.turn_no=t.turn_no AND q.status=200 ORDER BY q.n DESC LIMIT 1) FROM turns t "
        "WHERE t.run_id=? AND t.kind='task' AND t.attempt=1 ORDER BY t.turn_no", (run_id,))]
    return m


def fmt(values, kind):
    mean = statistics.mean(values)
    lo, hi = min(values), max(values)
    f = {'usd': lambda v: f'${v:.4f}', 'usd2': lambda v: f'${v:.2f}', 'int': lambda v: f'{v:,.0f}',
         'k': lambda v: f'{v / 1000:,.0f}K', 'm': lambda v: f'{v / 1e6:,.2f}M', 'min': lambda v: f'{v:.1f} min',
         's': lambda v: f'{v:.0f} s', 'n1': lambda v: f'{v:.1f}'}[kind]
    return f'{f(mean)} ({f(lo)} to {f(hi)})' if len(values) > 1 else f(mean)


def rows(n_exercises, tries, model):
    long_over = PRICES[next(k for k in PRICES if model.startswith(k))].get('long_over')
    long_row = (f'Agent requests with a prompt over {long_over // 1000}K tokens (priced at the long-prompt rate)'
                if long_over else f'Agent requests at a long-prompt rate ({model} has none)')
    return [
    ('Completion', None, None),
    (f'Exercises solved (hidden tests all pass, up to {tries} tries), of {n_exercises}', 'solved', 'n1'),
    ('Exercises solved on the first try', 'solved_first_try', 'n1'),
    ('Quality', None, None),
    ('Hidden tests passed, all exercises, final code', 'tests_passed', 'n1'),
    ('Hidden tests run, all exercises, final code', 'tests_total', 'n1'),
    (f'Standing rule from turn 1 still followed, exercises of {n_exercises}', 'rule_kept', 'n1'),
    ('Time', None, None),
    ('Whole session wall time (sum of turns)', 'elapsed_min', 'min'),
    ('Median time per exercise turn', 'median_turn_s', 's'),
    (f'Cost, whole session (cumulative), at each model\'s list prices (agent: {model})', None, None),
    ('Agent (Claude Code) cost', 'agent_cost', 'usd'),
    ('Observer (claude-mem note-taker) cost', 'observer_cost', 'usd'),
    ('Total cost', 'total_cost', 'usd'),
    ('Same tokens at Opus 5.5 flat list prices: agent', 'agent_cost_opus', 'usd2'),
    ('Agent tokens at Opus 5.5 flat prices + observer at its own price: total', 'total_cost_opus', 'usd2'),
    ('Tokens, whole session (cumulative)', None, None),
    ('Agent prompt tokens sent (input + cache writes + cache reads)', 'agent_prompt_tokens', 'm'),
    ('Agent output tokens', 'agent_output_tokens', 'k'),
    ('Observer prompt tokens', 'observer_prompt_tokens', 'm'),
    ('Agent requests', 'agent_requests', 'n1'),
    ('Context size, per request', None, None),
    ('Largest single agent prompt', 'agent_max_prompt', 'k'),
    (long_row, 'agent_long_requests', 'n1'),
    ('Reliability', None, None),
    ('Turns Claude Code ended in an error (before the one retry)', 'retried_turns', 'n1'),
    ('Turns still in error after the retry', 'error_turns', 'n1'),
    ('Requests the API refused (non-200)', 'failed_requests', 'n1'),
    ('Requests whose response was cut off before its end (usage may be short)', 'incomplete_requests', 'n1'),
    ]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--db', required=True)
    p.add_argument('--out')
    args = p.parse_args()
    db = sqlite3.connect(args.db)
    runs = {}
    settings = {}
    for run_id, arm, model, tries, exercises, ended_at, notes in db.execute(
            'SELECT run_id, arm, model, tries, exercises, ended_at, notes FROM runs ORDER BY run_id'):
        if not ended_at or (notes or '').startswith('invalid'):
            print(f'left out: {run_id} ({notes or "not finished"})', file=sys.stderr)
            continue
        settings.setdefault((model, tries, exercises), []).append(run_id)
        runs.setdefault(arm, []).append(run_metrics(db, run_id))
    if len(settings) != 1:
        sys.exit('runs with different settings (model, tries or exercises) cannot share one table: '
                 + '; '.join(f'{k[0]}, {k[1]} tries, {len(k[2].split(","))} exercises: {", ".join(v)}' for k, v in settings.items()))
    (model, tries, exercises), = settings
    price_of(model)  # refuses a model with no price
    arms = [a for a in ('plain', 'endless') if a in runs] + sorted(a for a in runs if a not in ('plain', 'endless'))
    names = {'plain': 'Plain Claude Code', 'endless': 'Endless Mode, note-taker on its default (Haiku 4.5)',
             'endless-observer-haiku55': 'Endless Mode, note-taker on Haiku 5.5'}
    label = {a: f'{names.get(a, a)} ({len(runs[a])} runs)' for a in arms}
    lines = ['| Measure | ' + ' | '.join(label[a] for a in arms) + ' |', '|---|' + '---|' * len(arms)]
    for title, key, kind in rows(len(exercises.split(',')), tries, model):
        if key is None:
            lines.append(f'| **{title}** |' + ' |' * len(arms))
            continue
        lines.append(f'| {title} | ' + ' | '.join(fmt([m[key] for m in runs[a]], kind) for a in arms) + ' |')
    lines += ['', 'Agent prompt size at the end of each exercise\'s first try (per request, mean over runs, K tokens):', '']
    lines.append('| Exercise # | ' + ' | '.join(arms) + ' |')
    lines.append('|---|' + '---|' * len(arms))
    n = max(len(m['prompt_by_exercise']) for a in arms for m in runs[a])
    for i in range(0, n, 3 if n > 12 else 1):
        cells = []
        for a in arms:
            vals = [m['prompt_by_exercise'][i] for m in runs[a] if i < len(m['prompt_by_exercise']) and m['prompt_by_exercise'][i]]
            cells.append(f'{statistics.mean(vals) / 1000:,.0f}' if vals else '')
        lines.append(f'| {i + 1} | ' + ' | '.join(cells) + ' |')
    text = '\n'.join(lines) + '\n'
    if args.out:
        open(args.out, 'w').write(text)
    print(text)


if __name__ == '__main__':
    main()
