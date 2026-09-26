#!/usr/bin/env python3
"""agent-cost-report CLI: collect | prices | rollup | review | render | pdf | sync-check.

Phase 1: `collect` (measured token usage from local transcripts) and `prices` (OpenRouter public
price snapshot). Phase 2: `rollup` (report.json, line-items.csv, evidence.json, labels.review.json)
and `review --apply`. The other subcommands are registered and exit with a clear "not implemented" error. Stdlib only; python3.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acr import devices, measure, period, render, rollup, sample, sync, transcripts  # noqa: E402
from acr import prices as prices_mod  # noqa: E402

USAGE_FILE = "usage.json"
NOT_YET = ()


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
    if args.export_device:                              # Phase 5: per-device export (ids, timestamps, tokens, models; no text)
        try:
            ep, doc = devices.export(args.export_device, doc, args.out, block, live_db=getattr(args, "db", None))
        except (OSError, ValueError) as ex:
            sys.exit(f"acr.py collect --export-device: {ex}")
        print(f"export: device={args.export_device} rows={len(doc['rows'])} sessions={len(doc['sessions'])} -> {ep} ({os.path.getsize(ep)} bytes; safe to copy: no prompt or observation text)")


def cmd_prices(args):
    try:
        path, p = prices_mod.ensure(args.out, args.prices, args.url)
    except prices_mod.PriceError as ex:
        sys.exit(f"acr.py prices: {ex}\n"
                 f"No price table means no dollar figures; nothing is priced at zero. "
                 f"Pass --prices <saved prices.json> to run offline.")
    basis = f"loaded from {p['loaded_from']}" if p.get("loaded_from") else f"fetched {p['fetched']} from {p['source']}"
    print(f"prices: {len(p['models'])} models, {basis} -> {path}")


def cmd_rollup(args):
    if args.session and (args.start or args.end or args.project):
        sys.exit("acr.py rollup: --session takes no --start/--end/--project")
    try:
        rollup.run_rollup(args)
    except (ValueError, rollup.prices_mod.PriceError, FileNotFoundError) as ex:
        sys.exit(f"acr.py rollup: {ex}")


def cmd_review(args):
    try:
        rollup.run_review(args)
    except (OSError, ValueError) as ex:
        sys.exit(f"acr.py review: {ex}")


def cmd_render(args):
    try:
        html_path = render.render_file(args.inp, args.out, print_mode=False)
        print(f"render: {html_path}")
        if args.print or args.pdf_ready:
            print(f"render: {render.render_file(args.inp, args.out, print_mode=True)}")
    except (FileNotFoundError, KeyError, ValueError) as ex:
        sys.exit(f"acr.py render: {ex}")


def cmd_pdf(args):
    try:
        path, msg = render.pdf(args.out, chrome=args.chrome)
    except FileNotFoundError as ex:
        sys.exit(f"acr.py pdf: {ex}")
    print(msg)


def cmd_measure(args):
    out = measure.measure(args.out)
    print(f"measure-openrouter: status={out['status']}" + (f" weekly={out.get('usage_weekly')} monthly={out.get('usage_monthly')} (USD, current UTC buckets)" if out["status"] == "ok" else f" ({out.get('reason') or out.get('http_status')})") + f" -> {args.out}/measured.json")


def cmd_sample(args):
    try:
        path, st = sample.write(args.inp, args.out, per_metric=args.per_metric, seed=args.seed)
    except (FileNotFoundError, KeyError) as ex:
        sys.exit(f"acr.py behavior-sample: {ex} (run rollup first; behavior.json must sit next to report.json)")
    print(f"behavior-sample: {st} -> {path}")


def cmd_sync(args):
    drift = sync.run(write=args.write, dests=args.dest or None)
    if drift: sys.exit(1)


def cmd_not_yet(args):
    sys.exit(f"acr.py {args.cmd}: not implemented in this phase (Phases 1-2 ship collect, prices, rollup, review)")


def build_parser():
    ap = argparse.ArgumentParser(prog="acr.py", description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("collect", help="measured token usage from local Claude Code / Codex transcripts -> usage.json")
    add_period_args(c)
    c.add_argument("--out", required=True, metavar="DIR", help="output directory")
    c.add_argument("--export-device", metavar="LABEL", help="also write device-usage-LABEL.json (usage rows + this machine's session id map; no text) for a rollup on another machine")
    c.add_argument("--db", metavar="FILE", help=argparse.SUPPRESS)
    c.set_defaults(fn=cmd_collect)

    p = sub.add_parser("prices", help="snapshot OpenRouter public prices -> prices.json (USD per MTok)")
    p.add_argument("--out", required=True, metavar="DIR", help="output directory")
    p.add_argument("--prices", metavar="FILE", help="use a saved prices.json instead of fetching")
    p.add_argument("--url", default=prices_mod.SOURCE_URL, help=argparse.SUPPRESS)
    p.set_defaults(fn=cmd_prices)

    r = sub.add_parser("rollup", help="usage.json + prices.json + fresh DB snapshot -> report.json, line-items.csv, evidence.json, labels.review.json")
    add_period_args(r)
    r.add_argument("--out", required=True, metavar="DIR", help="directory holding usage.json and prices.json; outputs land here")
    r.add_argument("--prices", metavar="FILE", help="price table to use instead of DIR/prices.json")
    r.add_argument("--db", metavar="FILE", help=argparse.SUPPRESS)
    r.add_argument("--no-gh", action="store_true", help="skip every gh call: the merged-PR list source and the per-PR confirmation (wins from GitHub show as unavailable)")
    r.add_argument("--wins-repo", action="append", metavar="OWNER/REPO", help="repo(s) for the read-only merged-PR wins source (default: thedotmack/claude-mem; repeatable)")
    r.add_argument("--no-behavior", action="store_true", help="skip the Phase 2B behavior pass (no mistakes line)")
    r.add_argument("--classify", action="store_true", help="run the optional classifier on unsettled candidates (off by default, G8)")
    r.add_argument("--classify-budget", type=float, metavar="USD", help="hard cap per run for --classify (default $2.00, G8)")
    r.add_argument("--classify-model", metavar="MODEL", help=argparse.SUPPRESS)
    r.add_argument("--rules-dir", metavar="DIR", help="house rule files with dated HARD headers (rule effectiveness, 2B.10)")
    r.add_argument("--measured", metavar="FILE", help="measured.json from `measure-openrouter` (default: DIR/measured.json when present)")
    r.add_argument("--precision", metavar="FILE", help="JSON {pattern_key: precision} from the Phase 8.5 spot-check; tiles under 70%% move to Details")
    r.add_argument("--device-usage", metavar="FILE", action="append", default=[], help="device-usage-<label>.json export(s) from other machines to merge (repeatable)")
    r.set_defaults(fn=cmd_rollup)

    v = sub.add_parser("review", help="merge confirmed labels from a reviewed labels.review.json into report.json")
    v.add_argument("--apply", required=True, metavar="FILE", help="reviewed copy of labels.review.json")
    v.add_argument("--out", required=True, metavar="DIR", help="directory holding report.json")
    v.set_defaults(fn=cmd_review)

    rd = sub.add_parser("render", help="report.json -> self-contained report.html (Timing-style); --print also writes report.print.html with Details open")
    rd.add_argument("--in", dest="inp", required=True, metavar="FILE", help="report.json from `rollup`")
    rd.add_argument("--out", required=True, metavar="DIR", help="output directory (report.html lands here)")
    rd.add_argument("--print", action="store_true", help="also write report.print.html with the Details section open (for `pdf`)")
    rd.add_argument("--pdf-ready", action="store_true", help=argparse.SUPPRESS)
    rd.set_defaults(fn=cmd_render)

    pf = sub.add_parser("pdf", help="print DIR/report.print.html to DIR/report.pdf with headless Chrome (skipped if Chrome is missing)")
    pf.add_argument("--out", required=True, metavar="DIR", help="directory holding report.print.html (or report.json to render it)")
    pf.add_argument("--chrome", default="google-chrome", help=argparse.SUPPRESS)
    pf.set_defaults(fn=cmd_pdf)

    mo = sub.add_parser("measure-openrouter", help="per-key OpenRouter usage snapshot -> DIR/measured.json (unavailable without OPENROUTER_API_KEY in the environment)")
    mo.add_argument("--out", required=True, metavar="DIR", help="output directory")
    mo.set_defaults(fn=cmd_measure)

    bs = sub.add_parser("behavior-sample", help="Markdown spot-check sheet from behavior.json (Phase 8.5): random human/bot turns, flagged turns per tile, unflagged sessions")
    bs.add_argument("--in", dest="inp", required=True, metavar="FILE", help="report.json (behavior.json is read from the same directory)")
    bs.add_argument("--per-metric", type=int, default=20); bs.add_argument("--seed", type=int, default=7)
    bs.add_argument("--out", required=True, metavar="FILE", help="behavior-spotcheck.md")
    bs.set_defaults(fn=cmd_sample)

    sc = sub.add_parser("sync-check", help="compare SKILL.md, CHECKSUMS.txt and scripts/** against the house copy and the four mirrors; --write copies plugin -> destinations")
    sc.add_argument("--write", action="store_true", help="copy the plugin dir to every destination, then re-check")
    sc.add_argument("--dest", action="append", metavar="DIR", help="override the destination list (repeatable)")
    sc.set_defaults(fn=cmd_sync)

    for name in NOT_YET:
        n = sub.add_parser(name, help="(later phase)")
        n.set_defaults(fn=cmd_not_yet)
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
