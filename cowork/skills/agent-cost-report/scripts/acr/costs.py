"""Agent cost from measured tokens, observer cost kept apart, extrapolation (plan Phase 2.2).

api_equiv() copied from /workspace/weekly-cost-workflow/weekly_report.py:91-105 with the Phase 1
rate() (1h cache writes at the listed cache_write_1h, else 2 x input). Money is accumulated in
integer micro-dollars (tokens x USD/MTok is exactly micro-dollars). The observer (note-taker) cost
is priced at the input rate only (:70-73) and lives only in spend.observer_note_taker_est_usd.
Extrapolation copied from :239-246. Unpriced = rate() None, output price None, or any negative price
(OpenRouter lists -1 for a few variable routers): such rows are never multiplied.
"""
import collections

from . import prices as prices_mod

TOKEN_FIELDS = ("input", "output", "cache_write_5m", "cache_write_1h", "cache_read")
PRICE_FIELDS = ("input_usd_per_mtok", "output_usd_per_mtok", "cache_read", "cache_write", "cache_write_1h")


def usable_rate(rt):
    """A rate is usable only when every price is present and non-negative."""
    if not rt: return False
    return all(rt.get(f) is not None and rt[f] >= 0 for f in PRICE_FIELDS)


def api_equiv_x1e6(r, rt):
    """copied from weekly_report.py:91-105 (integer micro-dollars); None when unpriced."""
    if not usable_rate(rt): return None
    i = rt["input_usd_per_mtok"]
    return int(round(r["input"] * i + r["output"] * rt["output_usd_per_mtok"] + r["cache_write_5m"] * rt["cache_write"]
                     + r["cache_write_1h"] * rt["cache_write_1h"] + r["cache_read"] * rt["cache_read"]))


def price_block(rt):
    """model_prices_usd_per_mtok for a line item / by_model row."""
    if not rt: return None
    return dict(input=rt["input_usd_per_mtok"], output=rt["output_usd_per_mtok"], cache_read=rt["cache_read"],
                cache_write=rt["cache_write"], cache_write_1h=rt["cache_write_1h"], key=rt["key"], price_source=rt["price_source"])


class Pricer:
    """rate() with a per-model cache and the unpriced register."""
    def __init__(self, prices):
        self.models = prices["models"]; self._cache = {}
        self.unpriced = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))   # model -> role -> {calls, tokens}

    def rate(self, model):
        if model not in self._cache: self._cache[model] = prices_mod.rate(model, self.models)
        return self._cache[model]

    def usable(self, model):
        return usable_rate(self.rate(model))

    def reason(self, model):
        rt = self.rate(model)
        if rt is None: return "not in price list"
        if rt.get("output_usd_per_mtok") is None: return "no output price listed"
        return "negative (variable) price listed"

    def observer_input_rate(self, model):
        """USD/MTok input rate for the note-taker model, or None (then the tokens are registered as unpriced)."""
        rt = self.rate(model)
        if rt is None or rt["input_usd_per_mtok"] is None or rt["input_usd_per_mtok"] < 0: return None
        return rt["input_usd_per_mtok"]

    def unpriced_list(self):
        return [dict(model=m, role=role, calls=c["calls"], tokens=c["tokens"], reason=self.reason(m))
                for m, roles in sorted(self.unpriced.items()) for role, c in sorted(roles.items())]


def _zero():
    c = collections.Counter(); c.update({f: 0 for f in TOKEN_FIELDS}); return c


def price_rows(rows, pricer):
    """Accumulate usage rows per transcript session and per (src, model) (weekly_report.py:98-105).
    Returns (by_session, by_model, stamps_by_session). Unpriced rows count tokens and calls but no dollars."""
    by_session = collections.defaultdict(_zero); by_model = collections.defaultdict(_zero); stamps = collections.defaultdict(list)
    for r in rows:
        rt = pricer.rate(r["model"]); c = api_equiv_x1e6(r, rt)
        for tgt in (by_session[r["session"]], by_model[(r["src"], r["model"])]):
            for f in TOKEN_FIELDS: tgt[f] += r[f]
            tgt["calls"] += 1
            if c is None: tgt["unpriced_calls"] += 1
            else: tgt["usd_x1e6"] += c
        if c is None:
            u = pricer.unpriced[r["model"] or "<none>"]["agent"]; u["calls"] += 1; u["tokens"] += sum(r[f] for f in TOKEN_FIELDS)
        stamps[r["session"]].append(r["ts"])
        # per-session dominant model (by output tokens) for the line item's `model` field
        by_session[r["session"]]["model:" + (r["model"] or "")] += r["output"]
    return by_session, by_model, stamps


def dominant_model(counter):
    ms = [(v, k[6:]) for k, v in counter.items() if k.startswith("model:")]
    return max(ms)[1] if ms else None


def usd(x1e6):
    return round(x1e6 / 1e6, 2)


def extrapolation(items):
    """copied from weekly_report.py:239-246: ratio = measured agent USD per 1M observer tokens over sessions
    with a transcript, applied to the observer tokens of sessions with none. Only those sessions are touched.
    items: line-item dicts with has_transcript, observer_tokens, cost_x1e6 (measured micro-dollars)."""
    # transcripts with no claude-mem session (orphan=True) have no observer tokens and stay out of the ratio (weekly_report.py:239-246 basis)
    m_obs = sum(i["observer_tokens"] for i in items if i["has_transcript"] and not i.get("orphan"))
    m_usd = sum(i["cost_x1e6"] for i in items if i["has_transcript"] and not i.get("orphan")) / 1e6
    u_obs = sum(i["observer_tokens"] for i in items if not i["has_transcript"])
    ratio = m_usd / m_obs * 1e6 if m_obs else None
    total = 0
    for i in items:
        if not i["has_transcript"] and ratio is not None:
            i["extrapolated_x1e6"] = int(round(i["observer_tokens"] * ratio)); total += i["extrapolated_x1e6"]
        else:
            i["extrapolated_x1e6"] = 0
    n_un = sum(1 for i in items if not i["has_transcript"])
    if n_un == 0 and items: return 0.0, "all sessions measured (no extrapolation needed)", ratio      # plan 5.4: say so, never drop the line silently
    basis = (f"EXTRAPOLATED (low confidence): on this box, measured sessions cost ${ratio:.2f} API-equivalent per 1M observer tokens; "
             f"applied to {u_obs:,} observer tokens from {n_un} sessions with no transcript here (remote devices). "
             f"Assumes remote work looks like box work.") if ratio is not None else "n/a (no measured session to derive a ratio from)"
    return (round(total / 1e6, 2) if ratio is not None else None), basis, ratio
