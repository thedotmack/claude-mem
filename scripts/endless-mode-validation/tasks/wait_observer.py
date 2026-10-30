#!/usr/bin/env python3
"""Wait until an Endless arm's observer has finished what the session sent it, so its cost is counted whole.

Done when claude-mem's queue is empty, every observer request the tee recorded has its final response event, and no
new request has started for --quiet seconds. Exits 1 (and says so) if that does not happen within --max seconds;
extract.py then flags the unfinished requests.

Usage: wait_observer.py <arm dir> [--quiet 20] [--max 900]
"""
import argparse
import sqlite3
import sys
import time
from pathlib import Path


def queue_size(db):
    if not db.exists():
        return 0
    try:
        c = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=10)
        return c.execute('SELECT count(*) FROM pending_messages').fetchone()[0]
    except sqlite3.Error:
        return -1  # unreadable for now (busy or mid-migration): not done


def tee_state(tee):
    index = tee / 'index.tsv'
    numbers = [line.split('\t')[0] for line in index.read_text().splitlines()] if index.exists() else []
    unfinished = 0
    for n in numbers:
        raw = tee / f'{n}-resp.raw'
        text = raw.read_bytes() if raw.exists() else b''
        if not (text.lstrip().startswith(b'{') or b'message_stop' in text):
            unfinished += 1
    return len(numbers), unfinished


def main():
    p = argparse.ArgumentParser()
    p.add_argument('arm_dir', type=Path)
    p.add_argument('--quiet', type=float, default=20)
    p.add_argument('--max', type=float, default=900)
    args = p.parse_args()
    db = args.arm_dir / 'data' / 'claude-mem.db'
    tee = args.arm_dir / 'observer-tee'
    start = time.time()
    last_count, last_change = -1, time.time()
    while time.time() - start < args.max:
        count, unfinished = tee_state(tee)
        if count != last_count:
            last_count, last_change = count, time.time()
        if queue_size(db) == 0 and unfinished == 0 and time.time() - last_change >= args.quiet:
            print(f'{args.arm_dir.name}: observer done ({count} requests)')
            return 0
        time.sleep(2)
    print(f'{args.arm_dir.name}: observer still busy after {args.max:.0f} s', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
