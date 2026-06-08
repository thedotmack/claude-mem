# [plan-04] Installer Failure Transparency — cross-IDE detection & error taxonomy

## Defect

The installer's host/IDE detection is heuristic and silent when wrong. An npm-global Claude Code install on Windows is mis-detected as the "desktop app", which routes the user down a path that breaks headless memory generation — with no diagnostic that the wrong host class was chosen. This is the installer-transparency contract gap: detection must be explicit, verifiable, and loud when it cannot prove the host class.

## Children

- #2723 — Windows: npm-global Claude Code install mis-detected as "desktop app", breaking headless memory generation

## Fix sequence

Design doc: `plans/04-installer-transparency.md`. Make host/IDE detection explicit and assertable; emit the detected class + evidence; fail loud (not silent) on ambiguous detection; cover the npm-global-vs-desktop discriminator in the install test matrix.

## Test matrix

| Host | Install method | Detected class |
|---|---|---|
| Windows | npm -g Claude Code | CLI/headless (not desktop) |
| Windows | Claude Desktop | desktop |
| all | ambiguous | loud diagnostic, no silent mis-route |

## Out of scope

Packaging/tarball contents (plan-10); spawn templating (plan-02).
