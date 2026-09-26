"""Phase 5: per-device transcript export and merge (plan 5.2), so Mac sessions can move from
"extrapolated (low confidence)" to measured tokens without any transcript leaving the machine.

Export (runs on the machine that owns the transcripts): the Phase 1 collector rows for the window plus
that machine's local sdk_sessions map {memory_session_id -> content_session_id, project, started_at_epoch},
read from a read-only snapshot of its local claude-mem.db. Only ids, timestamps, token counts and model
names: no prompt text, no observation text, no settings, no file paths.

Merge (runs on the box): rows join to box-side sessions on memory_session_id (fallback content_session_id);
joined sessions flip from cost_basis extrapolated to estimated_usage with device=<label>. Whatever stays
unmeasured is extrapolated again and keeps its low-confidence label. Rows that match no box session are
counted as unmatched, like any other transcript.
"""
import datetime as dt
import json
import os
import platform

from . import period, snapshot

ROW_FIELDS = ("src", "session", "sidechain", "model", "ts", "input", "output", "cache_write", "cache_write_1h", "cache_write_5m", "cache_read", "cost_usd_reported")
FORBIDDEN = ("text", "prompt", "content", "title", "file", "cwd", "settings")


def export(label, usage_doc, outdir, window_block, live_db=None):
    """Write <outdir>/device-usage-<label>.json from a collect() document and the local DB. The DB
    snapshot is removed afterwards so the export directory holds only the small file."""
    rows = [dict({k: r.get(k) for k in ROW_FIELDS}, device=label) for r in usage_doc["rows"]]
    snap = snapshot.snapshot(outdir, live=live_db); db = snapshot.open_snapshot(snap)
    try:
        ids = sorted({r["session"] for r in rows if r["session"]})
        q = "select memory_session_id, content_session_id, project, started_at_epoch from sdk_sessions where "
        if window_block.get("start_epoch_ms") is not None:
            cur = db.execute(q + "started_at_epoch >= ? and started_at_epoch < ?", (window_block["start_epoch_ms"], window_block["end_epoch_ms"]))
        else:
            cur = db.execute(q + f"content_session_id in ({','.join('?' * len(ids))})", ids) if ids else []
        sessions = {r[0]: dict(content_session_id=r[1], project=r[2], started_at_epoch=r[3]) for r in cur if r[0]}
    finally:
        db.close()
        try: os.remove(snap)
        except OSError: pass
    doc = dict(device=label, host_label=platform.node(), exported_at_pt=period.now_pt().strftime("%Y-%m-%d %H:%M PT"), window=window_block,
               rows=rows, sessions=sessions, contents="usage rows (ids, timestamps, token counts, model names) and the local session id map; no text",
               behavior_export=None)   # per-session pattern counts / episode windows may be added later (plan 5.2, numbers only)
    assert not any(k in r for r in rows for k in FORBIDDEN)
    path = os.path.join(outdir, f"device-usage-{label}.json")
    with open(path, "w") as fh: json.dump(doc, fh)
    return path, doc


def load(path):
    with open(path) as fh: d = json.load(fh)
    for k in ("device", "window", "rows", "sessions"):
        if k not in d: raise ValueError(f"{path}: not a device-usage export (missing {k})")
    bad = [k for r in d["rows"] for k in FORBIDDEN if k in r]
    if bad: raise ValueError(f"{path}: export carries forbidden fields {sorted(set(bad))}")
    return d


def merge(rows, exports, sess, window_block):
    """Append exported rows to `rows`, re-keyed to the box session's content_session_id when the export's
    memory_session_id (or content id) is known on the box. Returns a summary per export."""
    by_mem = {mid: v["content_session_id"] for mid, v in sess.items()}
    by_cs = {v["content_session_id"] for v in sess.values()}
    seen = {(r["session"], r["ts"], r["input"], r["output"], r["cache_read"]) for r in rows}
    S, E = window_block.get("start_epoch_ms"), window_block.get("end_epoch_ms")           # None for a --session run (no period)
    out = []
    for d in exports:
        label = d["device"]; mem_by_cs = {v["content_session_id"]: mid for mid, v in d["sessions"].items()}
        joined = unmatched = dup = outside = 0
        for r in d["rows"]:
            if S is not None and not (S <= _ts_ms(r["ts"]) < E): outside += 1; continue    # a wrong-period export never inflates the headline
            cs = r["session"]; mid = mem_by_cs.get(cs)
            if mid in by_mem: cs2 = by_mem[mid]; joined += 1
            elif cs in by_cs: cs2 = cs; joined += 1
            else: cs2 = cs; unmatched += 1
            key = (cs2, r["ts"], r["input"], r["output"], r["cache_read"])
            if key in seen: dup += 1; continue
            seen.add(key)
            rows.append(dict(r, session=cs2, device=label, file=None, dir=f"device:{label}", cwd=None, export_memory_session_id=mid, export_session=cs))
        same_window = (d["window"].get("start_pt"), d["window"].get("end_exclusive_pt")) == (window_block.get("start_pt"), window_block.get("end_exclusive_pt"))
        out.append(dict(device=label, host_label=d.get("host_label"), exported_at_pt=d.get("exported_at_pt"), rows=len(d["rows"]), joined=joined, unmatched=unmatched, duplicates_skipped=dup,
                        outside_window=outside, window=d["window"], window_matches_report=same_window))
    return out


def _ts_ms(iso):
    return int(dt.datetime.fromisoformat(iso).timestamp() * 1000)
