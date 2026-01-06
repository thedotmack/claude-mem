Brainstorming Report: CLAUDE.md Distribution Architecture

  Problem Statement

  The current folder-level CLAUDE.md generation creates "messy repos" with many auto-generated files. While the feature is valuable (especially for PR reviews and team visibility), the file proliferation could annoy users.

  Solutions Explored

  1. Shell Magic / On-Read Population

  Explored various "magic alias" approaches where content populates dynamically on read:
  - Git smudge/clean filters - Transform at checkout, not truly on-read
  - FUSE filesystem - Virtual FS with dynamic generation, powerful but heavy
  - Named pipes (FIFOs) - Fragile, editors don't handle well
  - Symlinks to generated location - Simple but not on-demand

  2. Command Substitution (Exciting Discovery)

  Potential Claude Code feature request - support command substitution in context config:
  {
    "context": {
      "sources": [
        { "command": "claude-mem live-context ${CWD}" }
      ]
    }
  }
  Or folder-level .claude-context files containing just:
  exec: claude-mem live-context .
  Benefits: Zero files, pure dynamic context, no staleness, no merge conflicts ever.

  3. Ephemeral + Smart Push Architecture (Recommended)

  Phase 1: Ephemeral Local
  - Gitignore **/CLAUDE.md (keep root CLAUDE.md for user instructions)
  - Timeline data in separate file: claude-mem-timeline.csv
  - Generated fresh on SessionStart
  - Block Claude from reading timeline file via .claude/settings.local.json: "ignorePaths": ["claude-mem-timeline.csv"]
  - Prevents duplication (data already injected via context hook)

  Phase 2: Smart Push Timeline
  - Pre-push hook generates timeline from last commit to now
  - Writes claude-mem-timeline.csv and includes in push
  - Reviewers, CI/CD Claude agents, and team members see what happened
  - Clean separation: CLAUDE.md = human instructions, timeline.csv = machine context

  Phase 3: Team Sync (Pro Feature)
  - Post-pull hook: claude-mem sync --from-timeline
  - Parses timeline files, validates against local DB
  - Imports missing observations with provenance tracking
  - Conflict resolution for overlapping work
  - Monetization opportunity: Team sync as paid feature

  Key Insight: Clean Separation

  - CLAUDE.md = User-authored project instructions (Claude SHOULD read)
  - claude-mem-timeline.csv = Machine-generated context sync (blocked from reading, already injected)

  No collision between human documentation and machine context.
