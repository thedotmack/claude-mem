# UI languages

The classic memory viewer (`/viewer`), My Work, first-run setup, and Observation
TV support English, Simplified Chinese, Korean and French. Use the **Language**
menu in the viewer header, My Work header, or setup header to select **简体中文**,
**한국어**, or **Français**. My Work also supports **Türkçe**.

English remains the default. The choice is saved in browser local storage and
shared between pages on the same origin (including TV); it does not change
worker configuration or send a language setting to any provider. If browser
storage is unavailable, the choice lasts for the current page.

## What is translated

Application navigation, headings, controls, state labels, prompts, confirmation
dialogs, accessibility labels, settings descriptions and known UI error envelopes.
Recorded requests, memory titles, narratives, quotes, file paths, model identifiers,
commands, product names and opaque server error details remain verbatim.
The display language does not change the language of generated memories. Configure
`CLAUDE_MEM_MODE=code--zh` or `code--ko` separately when Chinese or Korean observations are wanted.

## Development

- `src/ui/i18n/index.ts`: shared React subscription and translation lookup.
- `src/ui/i18n/locale.ts`: locale normalization and safe placeholder interpolation.
- `src/ui/i18n/*-zh.ts`, `*-ko.ts`, `*-fr.ts`, `mywork-tr.ts`: catalogs using the exact English source text as keys.
- `interpolate(t('Moved {title} to {area}'), { title, area })` substitutes once,
  preserving dollar signs and placeholder-like text inside user values.
- Components subscribe with `useI18n()` so an already-open page updates on selection.
- Keep unknown/user-authored values out of translation lookup.

Run `npm run typecheck` at the repository root, then `npm run build` and `npm test`
in `src/ui/my-work`. Additional checks run with:

```sh
node --test tests/ui-i18n.test.ts tests/ui-mywork-interpolation.test.ts
# Viewer tests import TSX; use Bun as in the existing viewer test suite:
bun test tests/viewer/i18n-errors.test.ts
```

## Adding a language

1. Add the locale code and its native name to `LOCALE_NAMES` in `src/ui/i18n/locale.ts`.
   The language menus list it from there.
2. Add one catalog per area (`viewer`, `mywork`, `setup`, `settings`) with the same keys as
   the `-zh` catalogs, and register them in `catalogs` in `src/ui/i18n/core.ts`.
3. Add the language's labels to `tvText` in `src/ui/tv.html` and its Today, Yesterday,
   am and pm words to `WORDS` in `src/ui/my-work/src/lib/display-time.ts`.
4. Add the catalogs to `tests/ui-i18n.test.ts`.

The tests verify catalog content, matching placeholders, shared wording, coverage
of literal `t()` calls, safe user-text interpolation and language-independent
stored error messages. They do not claim every possible server-produced message
is translated.
