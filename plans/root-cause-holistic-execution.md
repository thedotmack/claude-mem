# Root Cause Holistic Fixes Execution Notes

Branch: `plan/root-cause-holistic-fixes`
Plan issue: https://github.com/thedotmack/claude-mem/issues/3138
Local draft read: `/tmp/claude-mem-three-track/plan-root-cause.md`

## Phase 0 Intake

The GitHub plan issue is open and matches the local draft. Existing master
plans #2779 and #2782 remain source material, not duplicates to close.

Current PR state was checked with:

```bash
gh api 'repos/thedotmack/claude-mem/pulls?state=all&per_page=100' --paginate
```

All queried PRs named by the plan are still open as of this execution note.
No child issue is closed by this branch note alone.

## PR Disposition

Disposition means how this holistic branch should handle the PR. "Consume"
means copy the tested/source-level contract when it matches the phase. "Supersede"
means implement the root-cause contract here instead of merging the PR wholesale.

### Consume In Phase

- Worker lifecycle: #3112, #3099, #3055, #3009, #2998, #2980, #2937, #2895, #2892, #2830, #2828.
- Chroma: #3116, #3108, #3102, #3011, #2940, #2920, #2880.
- Windows host/process: #3095, #3046, #3033, #2997, #2945, #2944, #2921, #2890.
- Install/runtime: #3113, #3110, #3066, #3058, #3018, #3006, #2918, #2887, #2710, #2531, #2597.
- Migration/data: #3065, #3063, #3044, #3041, #3002, #2904, #2849, #2770, #2632.
- Observer: #3136, #2943, #2942, #2927, #2905, #2901, #2885, #2884, #2857, #2739.
- Project identity: #3047, #3005, #2883, #2856, #2858, #2827, #2665, #2671.
- Auth/env: #3084, #3060, #3018, #2629.

### Supersede Or Defer

- #2731 is a high-risk UDS infrastructure option and stays deferred unless the
  later worker lifecycle phases prove the existing HTTP worker contract cannot
  meet the plan goals.
- #2699 is a Windows canary aggregation branch; use it as verification source
  material, not as an implementation merge target.
- #2507 is superseded by the newer Windows host/process contract work that
  uses host-specific Windows command generation instead of one-off hook edits.

## Artifact Rule

Runtime artifacts must be produced by source edits plus `npm run build` or the
repository build scripts. Do not hand-edit generated `plugin/scripts/*.cjs`.
