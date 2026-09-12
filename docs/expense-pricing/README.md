# OpenRouter list-price history (CMEM expense join)

Daily published OpenRouter list prices (`$/MTok` input + output) for models that show up in Claude-Mem / CMEM observation expense reports, **2026-07-01 through 2026-09-08**.

Expense reports should do:

```text
tokens × this table
```

Do **not** join OpenRouter spend logs, generation ids, activity APIs, or management keys. Those are a different authority (`RECEIPT-JOIN.md`).

## Files

| File | Use |
|---|---|
| `openrouter-list-prices-daily.csv` | Join table: `date, model_id, input_per_mtok_usd, output_per_mtok_usd, source, confidence` |
| `openrouter-list-prices-daily.json` | Same rows plus aliases + metadata |
| `openrouter-list-prices-daily.full.csv` | Same prices plus `work_day`, `observed_on`, first/last seen |
| `popular-models-by-work-day.csv` | Top-5 OpenRouter popularity guess for each git work day |
| `sample-5-popular-models.csv` | Just the five platform-popular ids below, full window |

Regenerate from `scripts/openrouter-price-history/build-dataset.py`.

## Join recipe

Observation rows carry `generated_by_model` and `created_at` (or `created_at_epoch`).

1. `date = UTC calendar day of created_at`
2. `model_id = aliases[generated_by_model].openrouter_id` if present, else the raw id
3. `cmem-observer` → `deepseek/deepseek-v4-flash` on/after 2026-08-08, else `deepseek/deepseek-chat`
4. Look up `(date, model_id)` in the CSV
5. Cost:

```text
usd = (input_tokens  / 1e6) * input_per_mtok_usd
    + (output_tokens / 1e6) * output_per_mtok_usd
```

If the observation only stored a combined token count, use the input price (observer traffic is prompt-heavy; CMEM’s own notes treat ~98% input as the working shape). Prefer split input/output when you have them.

Unknown `(date, model_id)`: the model was not in this curated set that day. Do not invent a price.

## Confidence

| Value | Meaning |
|---|---|
| `exact_day` | A change-point exists on that UTC date (last point that day = end-of-day list price) |
| `nearest` | Carried forward from the latest earlier published point; model still listed |
| `fallback` | Last known published price after the id left the catalog (today: `xiaomi/mimo-v2-flash:free` at `$0`) |

OpenRouter’s models-API “list price” for multi-provider ids is the cheapest currently advertised route and can bounce intra-day. This dataset keeps the **last** snapshot of the day. That is list price, not cache-discounted billed cost.

## Coverage

- **Window:** 2026-07-01 … 2026-09-08 (70 days)
- **Work days:** 59 unique `git log --all` author dates on `thedotmack/claude-mem`
- **Models:** CMEM observer defaults + claude-mem OpenRouter defaults + five platform-popular ids that span July–September

No complete public daily price *and* rankings archive was recoverable without the keyed `/api/v1/datasets/rankings-daily` endpoint. Prices come from the [jvrck/openrouterlist](https://github.com/jvrck/openrouterlist) change-point ledger (`as_of` 2026-09-09), which itself diffs OpenRouter’s public models API about twice a day. Popularity is era-level (see sources on each popular-models row).

## Sample: five popular models, July → September

These five were the recoverable platform leaders across the window (Flash 0423 early July → Hy3/MiMo mid-July → Luna discount late July → Flash 0731 by September). Prices are list `$/MTok` on the 1st of each month in range, plus 2026-09-08.

| date | deepseek/deepseek-v4-flash | xiaomi/mimo-v2.5 | tencent/hy3 | openai/gpt-5.6-luna | deepseek/deepseek-v4-flash-0731 |
|---|---|---|---|---|---|
| 2026-07-01 | 0.098 / 0.196 `exact_day` | 0.105 / 0.28 `nearest` | — (listed Jul 7) | — (listed Jul 10) | — (listed Jul 31) |
| 2026-08-01 | 0.14 / 0.28 `nearest` | 0.14 / 0.28 `nearest` | 0.132 / 0.528 `nearest` | 0.10 / 0.60 `nearest` | 0.14 / 0.28 `nearest` |
| 2026-09-01 | 0.08092 / 0.16184 `exact_day` | 0.14 / 0.28 `nearest` | 0.132 / 0.528 `nearest` | 0.20 / 1.20 `nearest` | 0.065 / 0.18 `nearest` |
| 2026-09-08 | 0.08708 / 0.17416 `exact_day` | 0.14 / 0.28 `nearest` | 0.0825 / 0.33 `exact_day` | 0.20 / 1.20 `nearest` | 0.065 / 0.18 `exact_day` |

`xiaomi/mimo-v2-flash:free` (current claude-mem settings default) last appeared 2026-01-26 at `$0 / $0` — every July–September row is `fallback`.

## Rebuild

```bash
python3 scripts/openrouter-price-history/build-dataset.py
```

To refresh the ledger excerpt, download [prices.json](https://raw.githubusercontent.com/jvrck/openrouterlist/main/data/history/prices.json) and keep the same model ids as `sources/price-ledger-excerpt.json`.
