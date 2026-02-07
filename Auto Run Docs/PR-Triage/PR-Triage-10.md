# Phase 10: Documentation Batch

Quick wins — docs PRs are low-risk and can be merged rapidly after basic review.

## README Fixes (merge quickly)

- [x] Review and merge PR #953 (`Fix formatting in README for plugin commands` by @Leonard013). Single file, formatting fix. Steps: (1) `gh pr checkout 953` (2) Quick review for correctness (3) `gh pr merge 953 --rebase --delete-branch`
  - **Merged 2026-02-06.** Removed `>` blockquote characters from inside code blocks in README.md that prevented copy-paste of plugin install commands.

- [x] Review and merge PR #898 (`docs: update README.ko.md` by @youngsu5582). Single file, Korean README. Steps: (1) `gh pr checkout 898` (2) Quick review (3) `gh pr merge 898 --rebase --delete-branch`
  - **Merged 2026-02-06.** Fixed Korean markdown hyperlinks by adding spaces between URLs and Korean postpositions (에서, 의, 를) to prevent markdown from including Korean characters in the URL. 2 lines changed in `docs/i18n/README.ko.md`.

- [x] Review and merge PR #864 (`docs: update README.ja.md` by @eltociear). Single file, Japanese README. Steps: (1) `gh pr checkout 864` (2) Quick review (3) `gh pr merge 864 --rebase --delete-branch`
  - **Merged 2026-02-06.** Added spaces between markdown link closings and Japanese postposition `を参照` in 4 locations to prevent markdown from including Japanese characters in URLs. Also added missing newline at end of file. 5 lines changed in `docs/i18n/README.ja.md`.

- [x] Review and merge PR #637 (`docs: fix ja readme of md render error` by @WuMingDao). Single file render fix. Steps: (1) `gh pr checkout 637` (2) Quick review (3) `gh pr merge 637 --rebase --delete-branch`
  - **Merged 2026-02-06.** 5 of 6 original changes were already applied by PR #864. Git's rebase merge cleanly resolved the overlap, applying only the remaining fix: added spaces around bold markdown in the Ragtime license note (`は **PolyForm...** の下で`) to fix rendering. 1 line changed in `docs/i18n/README.ja.md`.

- [x] Review and merge PR #636 (`docs: fix zh readme of md render error` by @WuMingDao). Single file render fix. Steps: (1) `gh pr checkout 636` (2) Quick review (3) `gh pr merge 636 --rebase --delete-branch`
  - **Merged 2026-02-06.** Added spaces around bold markdown links (`**[text](url)**` → `**[text](url)** `) in 4 locations to fix Chinese markdown rendering where characters were absorbed into URLs. Also added missing newline at end of file. 5 lines changed in `docs/i18n/README.zh.md`.

## Larger Docs PRs

- [x] Review PR #894 (`docs: update documentation links to official website` by @fengluodb). 29 files — updates links across all READMEs. Steps: (1) `gh pr checkout 894` (2) Verify all links point to correct docs.claude-mem.ai pages (3) Spot-check a few files (4) If links are correct: `gh pr merge 894 --rebase --delete-branch`
  - **Merged 2026-02-06.** Updated documentation links in README.md and all 28 i18n README files from relative `docs/` path to `https://docs.claude-mem.ai/`. Also localized description text from "Browse markdown docs on GitHub" to "Browse on official website" in each language. 29 files, 1 line changed per file. CI passed (Greptile Review).

- [x] Review PR #907 (`i18n: add Traditional Chinese (zh-TW) README translation` by @PeterDaveHello). 31 files. Steps: (1) `gh pr checkout 907` (2) Verify translation file structure matches existing i18n pattern (3) Check that only translation files are added, no source changes (4) If clean: `gh pr merge 907 --rebase --delete-branch`
  - **Merged 2026-02-06.** Added full Traditional Chinese (zh-TW) README translation (311 lines) at `docs/i18n/README.zh-tw.md`. Added `🇹🇼 繁體中文` language nav link to all 29 existing READMEs plus main README.md. Updated `package.json` to include `zh-tw` in tier1 translation script. 31 files changed, 341 additions. CI passed (Greptile Review).

- [x] Review PR #691 (`feat: Add Urdu language support` by @yasirali646). 34 files. Steps: (1) `gh pr checkout 691` (2) Verify translation quality (spot-check a few sections) (3) Check file structure matches other language READMEs (4) If clean: `gh pr merge 691 --rebase --delete-branch`
  - **Merged 2026-02-06.** Added full Urdu (ur) README translation (311 lines) at `docs/i18n/README.ur.md` with RTL `<section dir="rtl">` wrapper and LTR language nav. Added `🇵🇰 اردو` language nav link to all 29 existing READMEs plus main README.md. Added Urdu mode file `plugin/modes/code--ur.json` matching existing mode structure. Updated translate-readme scripts (`cli.ts`, `index.ts`) with Urdu entry. Added Urdu to `docs/public/modes.mdx` table. 34 files changed, 368 additions. No CI checks configured.

## Windows-Specific Docs

- [x] Review and merge PR #919 (`docs: add Windows setup note for npm not recognized error` by @kamran-khalid-v9). Steps: (1) `gh pr checkout 919` (2) Review the note — should explain PATH configuration for npm on Windows (3) If helpful: `gh pr merge 919 --rebase --delete-branch`
  - **Merged 2026-02-06.** Added 11-line Windows setup note to README.md explaining how to resolve "npm is not recognized as the name of a cmdlet" error by installing Node.js and ensuring npm is on PATH. CI passed (Greptile Review). Fixes #908.

- [x] Review and merge PR #882 (`Add Windows local development notes to README` by @namratab18). Single file. Steps: (1) `gh pr checkout 882` (2) Quick review (3) `gh pr merge 882 --rebase --delete-branch`
  - **Closed 2026-02-06 (not merged).** Content was too generic — the 3 steps (install Git, clone repo, run project) aren't Windows-specific and duplicate the existing Development Guide link. README already has a "Windows Setup Notes" section (from PR #919) covering the most common Windows issue (npm PATH). Greptile review also flagged awkward placement and vague instructions.

## Issue Templates

- [x] Review and merge PR #970 (`fix: update bug and feature request templates to include duplicate check` by @bmccann36). 3 files (issue templates). Steps: (1) `gh pr checkout 970` (2) Review templates — adding a duplicate check reminder is good practice (3) `gh pr merge 970 --rebase --delete-branch`
  - **Merged 2026-02-06.** Added "Before submitting" section with duplicate check checkbox (`I searched existing issues and confirmed this is not a duplicate`) to top of both `bug_report.md` and `feature_request.md` issue templates. Also added `.idea/` to `.gitignore` and fixed missing newline at EOF. 3 files changed, 16 additions. CI passed (Greptile Review). Hard-coded upstream issues link is intentional per author — fork users should search upstream, not their empty fork tracker.
