# Phase 01: Close Junk/Spam Issues

This phase closes the most obvious non-issues: gibberish spam, empty bug templates with no content, and troll/rage-bait submissions. These require zero investigation — the titles and bodies speak for themselves. Closing these first reduces noise and makes the remaining triage clearer.

## Tasks

- [x] Close all junk/spam/troll issues with "not planned" reason. For each issue below, run the `gh issue close` command exactly as shown. Do NOT modify the comment text:
  - **#971** "dsafasdfasdfadsfasdf" by @testhellodslfa — gibberish spam, body is "dssafasdfa"
    ```bash
    gh issue close 971 --repo thedotmack/claude-mem --reason "not planned" --comment "Closing — this appears to be accidental/spam (gibberish title and body). If you have a real issue to report, please open a new issue with a clear description."
    ```
  - **#925** "iman" by @imanabhar35-ship-it — empty bug template, no content filled in
    ```bash
    gh issue close 925 --repo thedotmack/claude-mem --reason "not planned" --comment "Closing — this issue contains only the empty bug report template with no actual content. If you have a real bug to report, please open a new issue with details about what you experienced."
    ```
  - **#893** "Create" by @BennyKing12345 — empty bug template, no content filled in
    ```bash
    gh issue close 893 --repo thedotmack/claude-mem --reason "not planned" --comment "Closing — this issue contains only the empty bug report template with no actual content. If you have a real bug to report, please open a new issue with a description of the problem."
    ```
  - **#878** "hjgbjb" by @mpoornima895-ux — gibberish spam
    ```bash
    gh issue close 878 --repo thedotmack/claude-mem --reason "not planned" --comment "Closing — this appears to be accidental/spam (gibberish title and body). If you have a real issue to report, please open a new issue with a clear description."
    ```
  - **#881** "This is a clone of my creative works. This is copyright infringement..." by @jonhardwick-spec — rage bait / trolling
    ```bash
    gh issue close 881 --repo thedotmack/claude-mem --reason "not planned" --comment "Closing — claude-mem is an original open-source project. This issue does not describe an actionable bug or feature request."
    ```

- [x] Verify all 5 issues are closed by running:
  ```bash
  gh issue list --repo thedotmack/claude-mem --state open --json number --jq '[.[] | .number] | map(select(. == 971 or . == 925 or . == 893 or . == 878 or . == 881)) | length'
  ```
  Expected output: `0` (all should be closed). If any remain open, re-run the failed close command.
