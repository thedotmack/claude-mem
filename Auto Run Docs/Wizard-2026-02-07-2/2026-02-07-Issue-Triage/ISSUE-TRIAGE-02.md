# Phase 02: Close Meta/Non-Bug/Support Issues

This phase closes issues that are not bugs or feature requests: support questions, meta commentary about the project, resolution notes that aren't actionable, and issues filed against the wrong product. These clutter the tracker and should be closed with helpful, respectful responses.

## Tasks

- [x] Close meta commentary and non-constructive feedback issues: *(Closed #670, #883, #938 on 2026-02-07)*
  - **#670** "Closing issues quickly has nothing to do with software quality" by @zerobell-lee — Meta criticism about triage practices, not an actionable issue
    ```bash
    gh issue close 670 --repo thedotmack/claude-mem --reason "not planned" --comment "Appreciate the feedback. Issue triage is part of maintaining project health — closing resolved, duplicate, or spam issues helps contributors find real bugs faster. This isn't an actionable issue, so closing. Feel free to open issues for specific bugs or feature requests."
    ```
  - **#883** "176 branches is insane. repo owner needs to remove unnecessary branches." by @Ansh-dhanani — Repo hygiene feedback, not a bug
    ```bash
    gh issue close 883 --repo thedotmack/claude-mem --reason "not planned" --comment "Thanks for the note. Branch cleanup is handled as part of ongoing maintenance. This isn't an actionable bug or feature request, so closing the issue."
    ```
  - **#938** "Is this still getting worked on?" by @costa-marcello — Project status question
    ```bash
    gh issue close 938 --repo thedotmack/claude-mem --reason "completed" --comment "Yes! claude-mem is actively maintained. Recent releases include v9.0.17+ with significant improvements to hook reliability, worker stability, and security fixes. Check the CHANGELOG for details. Closing as this is a question rather than an issue."
    ```

- [x] Close support/help requests and wrong-product issues: *(Closed #633, #759, #880, #678 on 2026-02-07)*
  - **#633** "Help: How to install Cursor integration to other projects rather than claude-mem" by @imcom — Support question about cursor:install targeting
    ```bash
    gh issue close 633 --repo thedotmack/claude-mem --reason "completed" --comment "The \`cursor:install\` command installs hooks into your Cursor configuration globally — it doesn't need to be run per-project. If you're seeing it default to the claude-mem directory, ensure you're running it from your target project's root. Closing as a support question. If you continue to have issues, please open a new issue with specific error output."
    ```
  - **#759** "Can't install the plugin on Visual Studio Code" by @DendroStudios — Wrong product (VS Code ≠ Claude Code)
    ```bash
    gh issue close 759 --repo thedotmack/claude-mem --reason "not planned" --comment "claude-mem is a plugin for Claude Code (Anthropic's CLI tool), not Visual Studio Code. VS Code doesn't have a Claude Code plugin system. If you're looking to use claude-mem, you'll need Claude Code installed first. See the README for installation instructions."
    ```
  - **#880** "Cannot open Claude after installation" by @internationalJoke — User already resolved by rm -rf ~/.claude
    ```bash
    gh issue close 880 --repo thedotmack/claude-mem --reason "completed" --comment "It appears you resolved this by removing and reinstalling Claude Code. If this was caused by a specific claude-mem version, the recent v9.0.17+ releases have significantly improved startup reliability. If you experience this again on a current version, please open a new issue with your claude-mem version and error output."
    ```
  - **#678** "Resolution: PostToolUse hook not creating observations - switch to claude provider" by @pitimon — This is a resolution note, not a bug report
    ```bash
    gh issue close 678 --repo thedotmack/claude-mem --reason "completed" --comment "Thanks for documenting this resolution! This is a helpful note for others experiencing the same issue with OpenRouter. Closing since this is a resolution rather than an open bug. The underlying provider compatibility issue is tracked separately."
    ```

- [ ] Verify all 7 issues are closed by running:
  ```bash
  gh issue list --repo thedotmack/claude-mem --state open --json number --jq '[.[] | .number] | map(select(. == 670 or . == 883 or . == 938 or . == 633 or . == 759 or . == 880 or . == 678)) | length'
  ```
  Expected output: `0`. If any remain open, re-run the failed close command.
