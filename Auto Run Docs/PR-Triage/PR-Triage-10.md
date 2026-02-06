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

- [ ] Review PR #894 (`docs: update documentation links to official website` by @fengluodb). 29 files — updates links across all READMEs. Steps: (1) `gh pr checkout 894` (2) Verify all links point to correct docs.claude-mem.ai pages (3) Spot-check a few files (4) If links are correct: `gh pr merge 894 --rebase --delete-branch`

- [ ] Review PR #907 (`i18n: add Traditional Chinese (zh-TW) README translation` by @PeterDaveHello). 31 files. Steps: (1) `gh pr checkout 907` (2) Verify translation file structure matches existing i18n pattern (3) Check that only translation files are added, no source changes (4) If clean: `gh pr merge 907 --rebase --delete-branch`

- [ ] Review PR #691 (`feat: Add Urdu language support` by @yasirali646). 34 files. Steps: (1) `gh pr checkout 691` (2) Verify translation quality (spot-check a few sections) (3) Check file structure matches other language READMEs (4) If clean: `gh pr merge 691 --rebase --delete-branch`

## Windows-Specific Docs

- [ ] Review and merge PR #919 (`docs: add Windows setup note for npm not recognized error` by @kamran-khalid-v9). Steps: (1) `gh pr checkout 919` (2) Review the note — should explain PATH configuration for npm on Windows (3) If helpful: `gh pr merge 919 --rebase --delete-branch`

- [ ] Review and merge PR #882 (`Add Windows local development notes to README` by @namratab18). Single file. Steps: (1) `gh pr checkout 882` (2) Quick review (3) `gh pr merge 882 --rebase --delete-branch`

## Issue Templates

- [ ] Review and merge PR #970 (`fix: update bug and feature request templates to include duplicate check` by @bmccann36). 3 files (issue templates). Steps: (1) `gh pr checkout 970` (2) Review templates — adding a duplicate check reminder is good practice (3) `gh pr merge 970 --rebase --delete-branch`
