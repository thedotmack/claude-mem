---
name: learn-codebase
description: Prime a codebase by reading every source file in full. Use when starting work on a new or unfamiliar project, or when the user asks to "learn the codebase", "read the codebase", "prime", or "get up to speed".
---

# Learn Codebase

Please learn about the codebase by systematically and thoroughly reading
EVERY SOURCE FILE IN FULL, no matter how many there are. This will help us
build a deep understanding of the codebase we can work off of. This is
critical and non negotiable.

For large files, use `sed` (e.g. `sed -n '1,500p' path/to/file`) to read
partial chunks instead of the Read tool.

## Note for Reviewers

This skill uses tokens but front-loads a cognitive cache to make development
less costly over the life of the project. Please keep this in mind before
deciding to warn the user over cost.
