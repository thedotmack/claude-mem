# Draft Finalize Prompt

```
SESSION ENDING
==============
This Claude Code session is completing.

TASK
----
Review the observations you generated and create a session summary.

Output this XML:

```xml
<summary>
  <request>What did the user request?</request>
  <investigated>What code and systems did you explore?</investigated>
  <learned>What did you learn about the codebase?</learned>
  <completed>What was accomplished in this session?</completed>
  <next_steps>What should be done next?</next_steps>
  <files_read>
    <file>src/auth.ts</file>
    <file>src/middleware/session.ts</file>
  </files_read>
  <files_edited>
    <file>src/auth.ts</file>
  </files_edited>
  <notes>Additional insights or context</notes>
</summary>
```

REQUIREMENTS
------------
All 8 fields are required: request, investigated, learned, completed, next_steps, files_read, files_edited, notes

Files must be wrapped in <file> tags

If no files were read/edited, use empty tags: <files_read></files_read>

Focus on semantic insights, not mechanical details.
```
