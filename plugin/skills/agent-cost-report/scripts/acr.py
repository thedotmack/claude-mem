#!/usr/bin/env python3
"""agent-cost-report CLI: collect | prices | rollup | review | render | pdf | sync-check.

Phase 1 implements `collect` (measured token usage from local transcripts) and `prices`
(OpenRouter public price snapshot). The other subcommands are registered and exit with a
clear "not implemented in this phase" error. Stdlib only; python3.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acr import period, transcripts  # noqa: E402
from acr import prices as prices_mod  # noqa: E402

USAGE_FILE = "usage.json"
NOT_YET = ("rollup", "review", "render", "pdf", "sync-check")


def add_period_args(p):
    g = p.add_argument_group("period (PT calendar days, end exclusive)")
    g.add_argument("--start", metavar="YYYY-MM-DD", help="first PT day (default: --end minus 7 days)")
    g.add_argument("--end", metavar="YYYY-MM-DD", help="exclusive PT end day (default: today, so today is excluded)")
    g.add_argument("--session", metavar="CONTENT_SESSION_ID", help="one session only; no period filter")
    g.add_argument("--project", metavar="NAME", help="restrict to one claude-mem project (joined in rollup)")


def cmd_collect(args):
    if args.session and (args.start or args.end):
        sys.exit("acr.py collect: --session takes no --start/--end (a session run has no period filter)")
    if args.session:
        window = None
        block = period.session_block(args.session)
    else:
        try:
            window = period.resolve_window(args.start, args.end)
        except ValueError as ex:
            sys.exit(f"acr.py collect: {ex}")
        block = window.block()
    doc = transcripts.collect(window, session=args.session, window_block=block)
    if args.project:
        doc["project_filter"] = args.project  # applied when rows are joined to sdk_sessions (rollup)
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, USAGE_FILE)
    with open(path, "w") as fh:
        json.dump(doc, fh)
    c = doc["collector"]
    tokens = sum(r["input"] + r["output"] + r["cache_write"] + r["cache_read"] for r in doc["rows"])
    w = block
    span = f"session {args.session}" if args.session else f"{w['start_pt']} .. {w['end_exclusive_pt']} (exclusive) PT"
    print(f"collect: {span}; files_seen={c['files_seen']} rows={c['rows']} dedup_dropped={c['dedup_dropped']} "
          f"tokens={tokens} partial_last_day={w['partial_last_day']} -> {path}")


def cmd_prices(args):
    try:
        path, p = prices_mod.ensure(args.out, args.prices, args.url)
    except prices_mod.PriceError as ex:
        sys.exit(f"acr.py prices: {ex}\n"
                 f"No price table means no dollar figures; nothing is priced at zero. "
                 f"Pass --prices <saved prices.json> to run offline.")
    basis = f"loaded from {p['loaded_from']}" if p.get("loaded_from") else f"fetched {p['fetched']} from {p['source']}"
    print(f"prices: {len(p['models'])} models, {basis} -> {path}")


def cmd_not_yet(args):
    sys.exit(f"acr.py {args.cmd}: not implemented in this phase (Phase 1 ships only `collect` and `prices`)")


def build_parser():
    ap = argparse.ArgumentParser(prog="acr.py", description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("collect", help="measured token usage from local Claude Code / Codex transcripts -> usage.json")
    add_period_args(c)
    c.add_argument("--out", required=True, metavar="DIR", help="output directory")
    c.set_defaults(fn=cmd_collect)

    p = sub.add_parser("prices", help="snapshot OpenRouter public prices -> prices.json (USD per MTok)")
    p.add_argument("--out", required=True, metavar="DIR", help="output directory")
    p.add_argument("--prices", metavar="FILE", help="use a saved prices.json instead of fetching")
    p.add_argument("--url", default=prices_mod.SOURCE_URL, help=argparse.SUPPRESS)
    p.set_defaults(fn=cmd_prices)

    for name in NOT_YET:
        n = sub.add_parser(name, help="(later phase)")
        n.set_defaults(fn=cmd_not_yet)
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
