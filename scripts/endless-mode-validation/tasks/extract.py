#!/usr/bin/env python3
"""Read every request the tees recorded for a run and write its token usage and cost to the SQLite file.

Each request's usage comes from the provider's own response (the `message_start` usage and the final
`message_delta` output count), so these are measured numbers, not estimates. Two sources per run:
  agent     what Claude Code sent upstream (in the Endless arm, after the gateway's rewrite)
  observer  claude-mem's observer, which writes the observations Endless Mode folds into (Endless arm only)

Cost = tokens x list price. The price table is below with its source; a request whose prompt (input + cache writes
+ cache reads) is over a model's long-prompt threshold is priced at that model's long-prompt rates. `cost_opus55_usd`
prices the same tokens at Claude Opus 5.5's flat list prices, to show the comparison without the long-prompt step.

Usage: extract.py --db FILE --run-id ID --arm-dir DIR
"""
import argparse
import json
import sqlite3
from datetime import datetime
from pathlib import Path

# USD per million tokens. Source: Anthropic's model table as cached in the claude-api skill on 2026-10-06 (Haiku 5.5:
# $0.10 / $0.50 for prompts up to 100K tokens, $0.50 / $2.50 beyond; Haiku 4.5: $1 / $5), cache writes at 1.25x (5
# minutes) and 2x (1 hour) the input price and cache reads at 0.1x. Opus 5.5 from prices/anthropic-claude-opus-5-5.json.
PRICES = {
    'claude-haiku-5-5': {'input': 0.10, 'output': 0.50, 'long_over': 100_000, 'long_input': 0.50, 'long_output': 2.50},
    'claude-haiku-4-5': {'input': 1.00, 'output': 5.00},
    'claude-opus-5-5': {'input': 4.00, 'output': 20.00},
}
OPUS55 = PRICES['claude-opus-5-5']


def price_of(model):
    for key, value in PRICES.items():
        if model and model.startswith(key):
            return value
    raise SystemExit(f'no price for model {model!r}; add it to PRICES')


def cost(price, fresh, write_5m, write_1h, read, output, flat=False):
    prompt = fresh + write_5m + write_1h + read
    long_prompt = not flat and 'long_over' in price and prompt > price['long_over']
    inp = price['long_input'] if long_prompt else price['input']
    out = price['long_output'] if long_prompt else price['output']
    return (fresh * inp + write_5m * inp * 1.25 + write_1h * inp * 2 + read * inp * 0.1 + output * out) / 1e6, long_prompt


def usage_of(raw):
    """(model, usage dict, final output tokens) from a saved response: an SSE stream or a JSON body."""
    text = raw.decode('utf-8', errors='replace')
    model, usage, output = None, None, None
    if text.lstrip().startswith('{'):
        body = json.loads(text)
        return body.get('model'), body.get('usage') or {}, (body.get('usage') or {}).get('output_tokens')
    for line in text.splitlines():
        if not line.startswith('data: '):
            continue
        try:
            event = json.loads(line[6:])
        except json.JSONDecodeError:
            continue
        if event.get('type') == 'message_start':
            model = event['message'].get('model')
            usage = event['message'].get('usage') or {}
            output = usage.get('output_tokens')
        elif event.get('type') == 'message_delta' and event.get('usage'):
            output = event['usage'].get('output_tokens', output)
            usage = {**(usage or {}), **{k: v for k, v in event['usage'].items() if v is not None and k != 'output_tokens'}}
    return model, usage, output


SCHEMA = """
CREATE TABLE IF NOT EXISTS requests (
  run_id TEXT, source TEXT, n INTEGER, time TEXT, epoch REAL, turn_no INTEGER, status INTEGER, model TEXT,
  input_tokens INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER, cache_read INTEGER, output_tokens INTEGER,
  prompt_tokens INTEGER, long_prompt INTEGER, cost_usd REAL, cost_opus55_usd REAL,
  PRIMARY KEY (run_id, source, n)
);
"""


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--db', required=True)
    p.add_argument('--run-id', required=True)
    p.add_argument('--arm-dir', required=True, type=Path)
    args = p.parse_args()
    db = sqlite3.connect(args.db, timeout=60)
    db.executescript(SCHEMA)
    turns = db.execute('SELECT turn_no, started_epoch, ended_epoch FROM turns WHERE run_id=? ORDER BY turn_no',
                       (args.run_id,)).fetchall()
    db.execute('DELETE FROM requests WHERE run_id=?', (args.run_id,))
    count = 0
    for source, folder in (('agent', 'tee'), ('observer', 'observer-tee')):
        statuses = {}
        index = args.arm_dir / folder / 'index.tsv'
        if not index.exists():
            continue
        for line in index.read_text().splitlines():
            n, _method, _path, status, _ctype = line.split('\t')
            statuses[n] = int(status)
        for n, status in sorted(statuses.items()):
            meta = json.loads((args.arm_dir / folder / f'{n}-req.json').read_text())
            epoch = datetime.fromisoformat(meta['time'].replace('Z', '+00:00')).timestamp()
            # The turn a request belongs to: the one running when it was sent (observer work after the last turn: none).
            turn_no = next((t for t, start, end in turns if start <= epoch <= end), None)
            model, usage, output = usage_of((args.arm_dir / folder / f'{n}-resp.raw').read_bytes())
            if status != 200 or usage is None:
                db.execute('INSERT INTO requests (run_id, source, n, time, epoch, turn_no, status, model) VALUES (?,?,?,?,?,?,?,?)',
                           (args.run_id, source, int(n), meta['time'], epoch, turn_no, status, model))
                continue
            fresh = usage.get('input_tokens') or 0
            read = usage.get('cache_read_input_tokens') or 0
            split = usage.get('cache_creation') or {}
            write_1h = split.get('ephemeral_1h_input_tokens') or 0
            write_5m = split.get('ephemeral_5m_input_tokens')
            if write_5m is None:
                write_5m = (usage.get('cache_creation_input_tokens') or 0) - write_1h
            output = output or 0
            usd, long_prompt = cost(price_of(model), fresh, write_5m, write_1h, read, output)
            usd_opus, _ = cost(OPUS55, fresh, write_5m, write_1h, read, output, flat=True)
            db.execute('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (args.run_id, source, int(n), meta['time'], epoch, turn_no, status, model, fresh, write_5m,
                        write_1h, read, output, fresh + write_5m + write_1h + read, int(long_prompt), usd, usd_opus))
            count += 1
    db.commit()
    print(f'{args.run_id}: {count} requests with usage')


if __name__ == '__main__':
    main()
