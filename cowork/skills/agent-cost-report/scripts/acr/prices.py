"""OpenRouter public price list and per-model rate lookup (plan Phase 1.5).

fetch() copied from /workspace/weekly-cost-workflow/fetch_prices.py:3-7 (extended with
cache_write_1h); norm()/rate() copied from weekly_report.py:23-42 with the PRICE-TABLE
fallback dropped (hard-coded path, plan Phase 0 A) and one rule change for 1h cache writes.
Never prices silently at zero: a failed fetch without --prices is an error.
"""
import datetime as dt
import json
import os
import re
import urllib.request

SOURCE_URL = "https://openrouter.ai/api/v1/models"
PRICES_FILE = "prices.json"


class PriceError(RuntimeError):
    pass


def fetch(url=SOURCE_URL, timeout=60):
    """GET the public model list (no key) -> {fetched, source, models}. USD per 1M tokens.
    The response is read as a stream into json.load; only the pricing fields are kept."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            # copied from fetch_prices.py:4: d = json.load(urllib.request.urlopen(URL))["data"]
            d = json.load(resp)["data"]
    except Exception as ex:
        raise PriceError(f"could not fetch {url}: {ex}") from ex
    # copied from fetch_prices.py:5-7, plus cache_write_1h (pricing.input_cache_write_1h, live on some Anthropic models)
    f = lambda v: None if v in (None, "") else float(v) * 1e6
    out = {m["id"]: dict(input=f((m.get("pricing") or {}).get("prompt")), output=f((m.get("pricing") or {}).get("completion")),
           cache_read=f((m.get("pricing") or {}).get("input_cache_read")), cache_write=f((m.get("pricing") or {}).get("input_cache_write")),
           cache_write_1h=f((m.get("pricing") or {}).get("input_cache_write_1h"))) for m in d}
    del d
    # copied from fetch_prices.py:9 (fetched / source / models shape)
    return dict(fetched=dt.datetime.now().astimezone().isoformat(), source=url, models=out)


def load(path):
    """A saved prices.json (from `acr.py prices`), for offline runs and the Phase 8 comparison."""
    try:
        with open(path) as fh:
            p = json.load(fh)
    except OSError as ex:
        raise PriceError(f"could not read --prices file {path}: {ex}") from ex
    except ValueError as ex:
        raise PriceError(f"--prices file {path} is not valid JSON: {ex}") from ex
    if not isinstance(p, dict) or not isinstance(p.get("models"), dict):
        raise PriceError(f"--prices file {path} has no 'models' table")
    p.setdefault("source", SOURCE_URL)
    p.setdefault("fetched", None)
    p["loaded_from"] = os.path.abspath(path)
    return p


def write(prices, outdir):
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, PRICES_FILE)
    with open(path, "w") as fh:
        json.dump(prices, fh, indent=1)
    return path


def ensure(outdir, prices_file=None, url=SOURCE_URL):
    """Use --prices <file> when given, else fetch live. Writes <outdir>/prices.json. Raises PriceError."""
    p = load(prices_file) if prices_file else fetch(url)
    return write(p, outdir), p


# copied from weekly_report.py:23-30; the PRICE-TABLE alias map (hard-coded path) is replaced by an optional dict
def norm(model, aliases=None):
    m = (aliases or {}).get(model, model)
    if "/" not in m:
        m = re.sub(r"-(\d{8})$", "", m)                       # drop date suffix
        m = re.sub(r"(\d)-(\d)$", r"\1.\2", m)                # 5-1 -> 5.1, 4-5 -> 4.5
        pref = "anthropic/" if m.startswith("claude") else "openai/" if m.startswith("gpt") else "google/" if m.startswith("gemini") else ""
        m = pref + m
    return m


# copied from weekly_report.py:31-42 (the PRICE-TABLE branch at :39-41 is dropped: hard-coded path).
# One change (plan 1.5): 1h cache write = explicit cache_write_1h when listed, else 2 x input
# (the old rule at weekly_report.py:95). price_source records which rule fired for each derived field.
def rate(model, models, aliases=None):
    """Returns dict(key, input_usd_per_mtok, output_usd_per_mtok, cache_read, cache_write, cache_write_1h,
    source, price_source) in USD / 1M tokens, or None (unpriced)."""
    if not model or model.startswith("<"): return None
    k = norm(model, aliases)
    if k in models and models[k].get("input") is not None:
        r = models[k]; i = r["input"]; src = {}
        if r.get("cache_read") is not None: cache_read = r["cache_read"]; src["cache_read"] = "listed"
        else: cache_read = i * 0.1; src["cache_read"] = "input*0.1"
        if r.get("cache_write") is not None: cache_write = r["cache_write"]; src["cache_write"] = "listed"
        else: cache_write = i * 1.25; src["cache_write"] = "input*1.25"
        if r.get("cache_write_1h") is not None: cache_write_1h = r["cache_write_1h"]; src["cache_write_1h"] = "listed"
        else: cache_write_1h = i * 2; src["cache_write_1h"] = "input*2"
        return dict(key=k, input_usd_per_mtok=i, output_usd_per_mtok=r.get("output"),
                    cache_read=cache_read, cache_write=cache_write, cache_write_1h=cache_write_1h,
                    source="openrouter-public-list", price_source=src)
    return None
