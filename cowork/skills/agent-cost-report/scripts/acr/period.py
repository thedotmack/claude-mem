"""PT period window (plan Phase 1.2).

Period arguments copied from /workspace/weekly-cost-workflow/parse_transcripts.py:8-14 and
weekly_report.py:11-14 (PT calendar days, end exclusive, ZoneInfo only), with defaults added
per the plan (G3): last 7 full PT days, today excluded. No fixed UTC offsets anywhere.
"""
import datetime as dt
import re
from dataclasses import dataclass
from zoneinfo import ZoneInfo

# copied from /workspace/weekly-cost-workflow/parse_transcripts.py:9 (same at weekly_report.py:11)
PT = ZoneInfo("America/Los_Angeles")

DEFAULT_DAYS = 7


DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_day(text):
    """'YYYY-MM-DD' (a PT calendar day) -> aware datetime at PT midnight.
    copied from parse_transcripts.py:10-11 / weekly_report.py:13-14:
    dt.datetime.fromisoformat(x).replace(tzinfo=PT). Strict: anything but a bare calendar day is
    rejected (datetime.fromisoformat would silently accept '2026-09-25+00:00' as a naive midnight)."""
    if not DAY_RE.match(text or ""):
        raise ValueError(f"expected a PT calendar day YYYY-MM-DD, got {text!r}")
    return dt.datetime.fromisoformat(text).replace(tzinfo=PT)


def epoch_ms(d):
    """copied from weekly_report.py:13-14: int(<aware dt>.timestamp() * 1000) -> UTC epoch milliseconds."""
    return int(d.timestamp() * 1000)


def pt_midnight(day):
    """Aware datetime at 00:00 PT on the given date (never ambiguous: DST switches at 02:00)."""
    return dt.datetime.combine(day, dt.time(0), tzinfo=PT)


def now_pt():
    return dt.datetime.now(PT)


@dataclass(frozen=True)
class Window:
    start: dt.datetime        # aware PT midnight; transcripts test s <= t < e
    end: dt.datetime          # aware PT midnight, exclusive
    generated_at: dt.datetime  # aware, PT

    @property
    def start_pt(self):
        return self.start.date().isoformat()

    @property
    def end_exclusive_pt(self):
        return self.end.date().isoformat()

    @property
    def start_epoch_ms(self):
        return epoch_ms(self.start)

    @property
    def end_epoch_ms(self):
        return epoch_ms(self.end)

    @property
    def generated_at_pt(self):
        return self.generated_at.strftime("%Y-%m-%d %H:%M PT")

    @property
    def partial_last_day(self):
        # Only an explicit --end later than today's PT date puts a not-yet-finished day in the window.
        # The default window ends at the midnight that started today, so this is False by construction.
        return self.end.date() > self.generated_at.date()

    def block(self):
        """The `window` block every output carries (shape after weekly_report.py:207-238 `window=`)."""
        return dict(start_pt=self.start_pt, end_exclusive_pt=self.end_exclusive_pt,
                    start_epoch_ms=self.start_epoch_ms, end_epoch_ms=self.end_epoch_ms,
                    generated_at_pt=self.generated_at_pt, partial_last_day=self.partial_last_day)


def resolve_window(start=None, end=None, now=None):
    """Build the PT window from optional --start/--end strings.

    Defaults (plan G3): end = the PT midnight that started today (today excluded);
    start = end - 7 days. `now` is injectable for tests (an aware datetime)."""
    now = (now or now_pt()).astimezone(PT)
    e = parse_day(end) if end is not None else pt_midnight(now.date())
    s = parse_day(start) if start is not None else pt_midnight(e.date() - dt.timedelta(days=DEFAULT_DAYS))
    if not s < e:
        raise ValueError(f"--start {s.date()} must be before --end {e.date()} (end is exclusive)")
    return Window(s, e, now)


def session_block(session, now=None):
    """`window` block for --session runs: no period filter, so the bounds are null."""
    now = (now or now_pt()).astimezone(PT)
    return dict(start_pt=None, end_exclusive_pt=None, start_epoch_ms=None, end_epoch_ms=None,
                generated_at_pt=now.strftime("%Y-%m-%d %H:%M PT"), partial_last_day=False, session=session)
