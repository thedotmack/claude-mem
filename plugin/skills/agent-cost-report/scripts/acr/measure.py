"""Phase 4: measured OpenRouter spend via the per-key endpoint (plan 4.1-4.4; G5 settled: a regular
inference OPENROUTER_API_KEY only, env var only, never a settings file, never a management key).

GET https://openrouter.ai/api/v1/key with `Authorization: Bearer <key>` returns data.usage (lifetime),
usage_daily (current UTC day), usage_weekly (current UTC week Mon-Sun), usage_monthly (current UTC month),
limit, limit_remaining, is_free_tier (verified 2026-09-25, plan Phase 0 E). Snapshots of the current
UTC calendar buckets, not a range query, so the figure is shown with its own bucket label and is never
re-cut to the PT window. The key is read once from the environment, never printed, never written.
"""
import datetime as dt
import json
import os
import urllib.error
import urllib.request

from .period import PT

URL = "https://openrouter.ai/api/v1/key"
ENV = "OPENROUTER_API_KEY"
UNAVAILABLE = dict(status="unavailable", reason=f"{ENV} not provided")
NOTE_TAKER = "measured total includes note-taker calls if they share this key; the estimate excludes them"


def fetch(key, url=URL, opener=urllib.request.urlopen, timeout=30):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"})
    with opener(req, timeout=timeout) as resp: return json.load(resp)


def measure(outdir, env=None, opener=urllib.request.urlopen, now=None, url=URL):
    """Writes <outdir>/measured.json and returns it. No key material in the output, ever."""
    env = os.environ if env is None else env
    key = env.get(ENV)
    now = now or dt.datetime.now(dt.timezone.utc)
    if not key: out = dict(UNAVAILABLE)
    else:
        try:
            d = (fetch(key, url=url, opener=opener) or {}).get("data") or {}
            out = dict(status="ok", source=url, fetched_at_utc=now.isoformat(timespec="seconds"), fetched_at_pt=now.astimezone(PT).isoformat(timespec="minutes"),
                       usage_daily=d.get("usage_daily"), usage_weekly=d.get("usage_weekly"), usage_monthly=d.get("usage_monthly"), usage_lifetime=d.get("usage"),
                       limit=d.get("limit"), limit_remaining=d.get("limit_remaining"), is_free_tier=d.get("is_free_tier"), key_hint=None)
        except urllib.error.HTTPError as ex: out = dict(status="error", http_status=ex.code)
        except (urllib.error.URLError, OSError, ValueError) as ex: out = dict(status="error", http_status=None, reason=type(ex).__name__)
    del key
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "measured.json"), "w") as fh: json.dump(out, fh, indent=1)
    return out


def _week_start(t):
    return (t - dt.timedelta(days=t.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)


def bucket_rule(measured, window_block, now=None):
    """Plan 4.2: pick the UTC bucket (week, else month) whose figure is shown, say whether it fully covers
    the PT report window (bucket_start_utc <= window_start_utc and now >= window_end_utc), and label it."""
    if not measured or measured.get("status") != "ok": return None
    fetched = dt.datetime.fromisoformat(measured["fetched_at_utc"]); now = now or fetched
    if window_block.get("start_epoch_ms") is None or window_block.get("end_epoch_ms") is None:      # --session run: no period window
        week0 = _week_start(fetched)
        return dict(bucket="usage_weekly", bucket_start_utc=week0.isoformat(timespec="seconds"), usd=measured.get("usage_weekly"),
                    label=f"OpenRouter measured, current UTC week {week0.strftime('%a %-d %b')} – now", covers_window=False, window_inside_bucket=False,
                    note="a session run has no period window; the measured bucket is shown for reference only", note_taker=NOTE_TAKER)
    ws = dt.datetime.fromtimestamp(window_block["start_epoch_ms"] / 1000, dt.timezone.utc); we = dt.datetime.fromtimestamp(window_block["end_epoch_ms"] / 1000, dt.timezone.utc)
    week0 = _week_start(fetched); month0 = fetched.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if ws >= week0: name, start, usd = "usage_weekly", week0, measured.get("usage_weekly")
    else: name, start, usd = "usage_monthly", month0, measured.get("usage_monthly")
    covers = usd is not None and start <= ws and now >= we
    inside = start <= ws and we <= now + dt.timedelta(seconds=1)
    label = f"OpenRouter measured, current UTC {'week' if name == 'usage_weekly' else 'month'} {start.strftime('%a %-d %b')} – now"
    note = None if covers else "measured bucket does not match the report window; shown for reference"
    return dict(bucket=name, bucket_start_utc=start.isoformat(timespec="seconds"), usd=usd, label=label, covers_window=bool(covers), window_inside_bucket=bool(inside), note=note, note_taker=NOTE_TAKER)


def apply(report, measured, now=None):
    """Mutates report['spend']: the total switches to MEASURED only when the bucket fully covers the window;
    line items keep cost_basis estimated_usage (per-session measured cost is not available, plan 4.2)."""
    s = report["spend"]
    if not measured or measured.get("status") != "ok":
        s["agent_measured_usd"] = None
        s["measured_status"] = "unavailable" if not measured or measured.get("status") == "unavailable" else f"error (http {measured.get('http_status')})"
        s["measured_reference"] = None
        return s
    b = bucket_rule(measured, report["window"], now=now)
    s["measured_reference"] = b
    if b and b["covers_window"]:
        s["agent_measured_usd"] = round(float(b["usd"]), 2); s["measured_status"] = "ok (period bucket)"; s["measured_label"] = "MEASURED"
    else:
        s["agent_measured_usd"] = None; s["measured_status"] = "reference only (bucket does not cover the window)"
    return s
