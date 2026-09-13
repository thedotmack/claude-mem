#!/usr/bin/env python3
"""Expand vendored OpenRouter list-price change-points into a daily join table.

Does not call OpenRouter spend, activity, generation, or management APIs.
"""

from __future__ import annotations

import csv
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = Path(__file__).resolve().parent / "sources"
OUT = ROOT / "docs" / "expense-pricing"

WINDOW_START = date(2026, 7, 1)
WINDOW_END = date(2026, 9, 8)
SAMPLE_MODEL_IDS = [
    "deepseek/deepseek-v4-flash",
    "xiaomi/mimo-v2.5",
    "tencent/hy3",
    "openai/gpt-5.6-luna",
    "deepseek/deepseek-v4-flash-0731",
]

LEDGER_SOURCE = (
    "jvrck/openrouterlist data/history/prices.json "
    "(https://github.com/jvrck/openrouterlist, as_of {as_of})"
)


def daterange(start: date, end: date):
    cur = start
    while cur <= end:
        yield cur
        cur += timedelta(days=1)


def parse_day(value: str) -> date:
    return date.fromisoformat(value)


def last_point_on_or_before(points: list[list], day: date):
    chosen = None
    exact = False
    for point in points:
        point_day = parse_day(point[0])
        if point_day < day:
            chosen = point
        elif point_day == day:
            chosen = point
            exact = True
        else:
            break
    return chosen, exact


def confidence_for(day: date, first_seen: date, last_seen: date, exact: bool) -> str:
    if day < first_seen:
        return "fallback"
    if exact and first_seen <= day <= last_seen:
        return "exact_day"
    if first_seen <= day <= last_seen:
        return "nearest"
    return "fallback"


def load_json(name: str):
    return json.loads((SRC / name).read_text())


def era_for(day: date, eras: list[dict]) -> dict:
    iso = day.isoformat()
    for era in eras:
        if era["start"] <= iso <= era["end"]:
            return era
    raise KeyError(f"no popularity era for {iso}")


def main() -> None:
    ledger = load_json("price-ledger-excerpt.json")
    work = set(load_json("work-days.json")["days"])
    eras = load_json("popularity-eras.json")["eras"]
    aliases = load_json("aliases.json")
    as_of = ledger["as_of"]
    source = LEDGER_SOURCE.format(as_of=as_of)

    price_rows: list[dict] = []
    for model_id, rec in ledger["models"].items():
        points = rec["points"]
        first_seen = parse_day(rec["first_seen"])
        last_seen = parse_day(rec["last_seen"])
        keep_after_last_seen = last_seen < WINDOW_START and not rec.get("present_now")
        for day in daterange(WINDOW_START, WINDOW_END):
            if day < first_seen:
                continue
            if day > last_seen and not keep_after_last_seen:
                continue
            chosen, exact = last_point_on_or_before(points, day)
            if chosen is None:
                continue
            # Settings defaults that left the catalog before the window
            # stay joinable via last known published list price.
            if day > last_seen and keep_after_last_seen:
                conf = "fallback"
            else:
                conf = confidence_for(day, first_seen, last_seen, exact)
            iso = day.isoformat()
            price_rows.append(
                {
                    "date": iso,
                    "model_id": model_id,
                    "input_per_mtok_usd": float(chosen[1]),
                    "output_per_mtok_usd": float(chosen[2]),
                    "source": source,
                    "confidence": conf,
                    "work_day": iso in work,
                    "observed_on": chosen[0],
                    "model_first_seen": rec["first_seen"],
                    "model_last_seen": rec["last_seen"],
                }
            )

    price_rows.sort(key=lambda r: (r["date"], r["model_id"]))

    popular_rows: list[dict] = []
    for day in daterange(WINDOW_START, WINDOW_END):
        iso = day.isoformat()
        if iso not in work:
            continue
        era = era_for(day, eras)
        for rank, model_id in enumerate(era["top"], start=1):
            popular_rows.append(
                {
                    "date": iso,
                    "rank": rank,
                    "model_id": model_id,
                    "source": era["source"],
                    "confidence": era["confidence"],
                    "url": era.get("url", ""),
                }
            )

    OUT.mkdir(parents=True, exist_ok=True)

    price_public = [
        {
            "date": r["date"],
            "model_id": r["model_id"],
            "input_per_mtok_usd": r["input_per_mtok_usd"],
            "output_per_mtok_usd": r["output_per_mtok_usd"],
            "source": r["source"],
            "confidence": r["confidence"],
        }
        for r in price_rows
    ]

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = {
        "meta": {
            "generated_at": generated_at,
            "window": {"start": WINDOW_START.isoformat(), "end": WINDOW_END.isoformat()},
            "unit": "usd_per_million_tokens",
            "price_kind": "openrouter_published_list_price",
            "confidence_values": ["exact_day", "nearest", "fallback"],
            "row_count": len(price_public),
            "model_ids": sorted({r["model_id"] for r in price_public}),
            "work_day_count": len(work),
            "notes": [
                "List price is the OpenRouter models-API prompt/completion pair, not billed generation cost.",
                "Multi-provider models can bounce intra-day; the last change-point on a UTC date is used.",
                "Days after last_seen (or before first_seen for discontinued defaults) are labeled fallback.",
                "Do not join OpenRouter generation ids or activity APIs; multiply observation tokens × this table.",
            ],
        },
        "aliases": aliases["aliases"],
        "rows": price_public,
    }
    (OUT / "openrouter-list-prices-daily.json").write_text(json.dumps(payload, indent=2) + "\n")

    with (OUT / "openrouter-list-prices-daily.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "date",
                "model_id",
                "input_per_mtok_usd",
                "output_per_mtok_usd",
                "source",
                "confidence",
            ],
        )
        writer.writeheader()
        writer.writerows(price_public)

    with (OUT / "openrouter-list-prices-daily.full.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(price_rows[0].keys()))
        writer.writeheader()
        writer.writerows(price_rows)

    sample_rows = [r for r in price_public if r["model_id"] in SAMPLE_MODEL_IDS]
    with (OUT / "sample-5-popular-models.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "date",
                "model_id",
                "input_per_mtok_usd",
                "output_per_mtok_usd",
                "source",
                "confidence",
            ],
        )
        writer.writeheader()
        writer.writerows(sample_rows)

    with (OUT / "popular-models-by-work-day.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=["date", "rank", "model_id", "source", "confidence", "url"],
        )
        writer.writeheader()
        writer.writerows(popular_rows)

    (OUT / "popular-models-by-work-day.json").write_text(
        json.dumps({"meta": {"generated_at": generated_at, "row_count": len(popular_rows)}, "rows": popular_rows}, indent=2)
        + "\n"
    )

    counts = {}
    for row in price_public:
        counts[row["confidence"]] = counts.get(row["confidence"], 0) + 1
    print(f"wrote {len(price_public)} price rows ({counts}) and {len(popular_rows)} popularity rows")


if __name__ == "__main__":
    main()
