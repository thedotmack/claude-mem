# memory-eval — харнесс оценки качества памяти

Реализация §H из `plans/2026-07-31-memory-review-audit.md` («build the harness before the
system»). Данные — только реальная продакшн-БД `~/.claude-mem/claude-mem.db` (правило 9:
никаких синтетических бенчмарков).

Запуск:

```bash
bun scripts/memory-eval/run.ts build-gold [--limit N] [--no-judge]
bun scripts/memory-eval/run.ts eval [--d D] [--ranker recency|actr|both] [--retrieval fts|hybrid] [--limit N] [--no-judge]
bun scripts/memory-eval/run.ts fit-d [--grid 0.2..1.0] [--step 0.1] [--limit N]
bun scripts/memory-eval/run.ts mutation-test
bun scripts/memory-eval/run.ts erasure-test
bun scripts/memory-eval/run.ts retention-sweep [--apply]
bun scripts/memory-eval/run.ts filter-eval [--limit N] [--worker URL]
```

## Declared scoring target (правило 3)

**Запрос** — реальный `user_prompt` (джойн с `sdk_sessions`: проект, memory-сессия).
**Релевантные ids** — observations из той же memory-сессии, что и промпт
(`observations.memory_session_id`, superseded исключены). Кандидатный пул для judge —
session-linked + observations того же проекта в окне ±1 день (макс. 30).

- `--no-judge`: золото = только session-linkage (бесплатно, без LLM).
- с judge (default, sample = `--limit`, default 50): LLM-judge (`createSdkJudge`)
  подтверждает релевантность кандидатов; золото = подтверждённые ids.

Золотой набор сохраняется в `gold.json`. Известное ограничение: session-linked
observations созданы *после* промпта (в ответ на него) — харнесс измеряет «находит ли
поиск материал этой сессии», а не «что было доступно в момент промпта».

## Метрики (правила 1, 2, 4, 5)

- **Базelines всегда рядом**: `recency` (ранкер апстрима = `rankByStrength` с
  ALPHA=0/BETA=0) vs `actr` (`rankByStrength` с tunables); `fts` vs `hybrid` retrieval.
- **hit-rate@5** (лексическая) и **judge relevance@5** (LLM, 0..5 релевантных в топ-5);
  расхождение двух метрик считается per-query и выводится.
- **Cost-ось**: токены инъекции на запрос = Σ chars(title+narrative+facts)/4
  (`CHARS_PER_TOKEN_ESTIMATE` — та же оценка, что в заголовке инъекции).
- **Saturation**: доля запросов, чьё золото уже лежит в top-20 recency-блоке проекта
  без всякого поиска (прокси full-context; если высокая — eval не различает дизайны).

## Правила расхода квоты

LLM-вызовы — только через `createSdkJudge()` и только мимо/через дисковый кэш
`.gold-cache.json` (ключ = sha256 промпта + ids). Каждый отчёт указывает
`judge calls spent` и `cache hits`. `--no-judge` — полностью бесплатный режим.

## Мутации и erasure (правила 7, 8)

`mutation-test` и `erasure-test` работают на **временной копии** БД (serialize → temp
файл, удаляется после прогона). Продакшн-БД открывается только `readonly` +
`PRAGMA query_only`. Mutation: вставка противоречащего observation через
`SessionStore.storeObservation` → `supersedeObservation` → старый выпадает из
`queryObservationsMulti`, новый наследует старшую половину `reinforcement_dates`.
Erasure: `DELETE` observation/факта → отсутствие в FTS (`SessionSearch`) и в
инъекционном пуле; каскад G5: `eraseObservationCascade(successor)` сносит и его
tombstone (`superseded_by`-цепочка); provenance: резолв `source_observation_ids`
активного факта.

## Retention sweep (G2)

`retention-sweep` — CLI-путь политики удаления (та же логика, что
`POST /api/maintenance/retention-sweep`, модуль `src/services/reinforcement/retention.ts`).
Без флагов — dry-run на readonly прод-БД: только отчёт-кандидаты (возраст/сила/кап).
`--apply` выполняет sweep на **временной копии** (миграции догоняются через
`SessionStore`) и проверяет, что удалённые строки легли в `deleted_observations`
одним `batch_id`. Прод-БД из харнесса не sweept'ится никогда; политика opt-in
(`CLAUDE_MEM_RETENTION_ENABLED`, default off).

## Hybrid retrieval

Chroma на этой машине частично отключён, поэтому `--retrieval hybrid` fail-soft:
таймаут 8с / любая ошибка Chroma → откат на FTS-пул с пометкой `NOTE: hybrid: ...`
в отчёте.

## filter-eval (LLM relevance filter, вариант C)

Замер LLM-фильтра keep/drop поверх **живого воркера** (`--worker`, default
`http://127.0.0.1:37777`): top-5 кандидатов берётся через `/api/search?type=observations&format=json`
— тот же SearchManager-путь, что обслуживает прод-инъекцию `/api/context/semantic`.
Судья (`CachedJudge.filterCandidates`, 1 вызов на запрос, промпт: title + narrative≤300
символов, строгий JSON `{"verdicts":[...]}`, парсер fail-open как в dedup) решает, что
реально инъектировалось бы. Метрики: recall-preservation (gold-хит в top-5 пережил
фильтр), keep-rate, abstention на 10 заведомо-шумовых запросах, стоимость вызовов.
Порог рекомендации зафиксирован в коде: opt-in только при recall-preservation ≥ 95%.

## Отчёты

Каждая команда пишет `reports/<timestamp>-<command>.md` + `.json` рядом.

Тесты: `bun test tests/memory-eval*` (метрики — чистые функции; gold builder — на
`:memory:` БД через `SessionStore`).
