# Postmortem: Worker Debug Failure - 2025-11-17

## Incident Summary
Attempted to fix broken worker service. Worker was in crash loop with 225 restarts, failing with "MCP error -32000: Connection closed". Debug attempt failed and changes were reverted.

## What Went Wrong

### 1. **Jumped to Symptoms, Not Root Cause**
- Saw "MCP connection failed" errors in logs
- Immediately focused on MCP/Chroma connection code
- Never asked: "Why is this suddenly broken when it worked before?"
- Classic symptom chasing instead of root cause analysis

### 2. **Ignored the Build Pipeline**
- Worker file wasn't in the expected location (`plugin/worker-service.cjs` vs `plugin/scripts/worker-service.cjs`)
- Build output existed but search server was producing corrupted/error output
- Never investigated: "Is the build system broken?"
- Should have compared built artifacts between main and current branch

### 3. **Tried to Fix by Disabling Instead of Understanding**
- Final approach: comment out Chroma, comment out search server
- This is the opposite of debugging - it's just making things "work" by removing functionality
- User called this out as "duct tape around 5 things unrelated to the problem"
- Violated YAGNI/KISS by adding defensive complexity instead of fixing the actual issue

### 4. **Didn't Compare Working vs Broken State**
- User specifically said "we fixed this before"
- Should have immediately: `git diff main src/services/worker-service.ts`
- Did this eventually but didn't follow through on the findings
- The diff showed only search-everything additions - the core worker code was UNCHANGED
- This should have been a huge red flag: "If the code is the same, why is it broken?"

### 5. **Overcomplicated the Investigation**
- Started reading through ChromaSync implementation
- Traced through MCP connection code
- Analyzed startup sequences
- All of this was unnecessary if the root cause was a build issue

## What Should Have Happened

### Correct Debug Sequence:
1. ✅ Check worker status (`pm2 list`) - DONE
2. ✅ Check error logs - DONE
3. ❌ **Compare current code to main branch** - SKIPPED INITIALLY
4. ❌ **Check if built files are correct** - SKIPPED
5. ❌ **Test the build pipeline** - NEVER DONE
6. ❌ **Verify dependencies are installed** - NEVER CHECKED

### The Real Questions:
- Is this a code change or a build issue?
- What changed between working state and broken state?
- Are the built artifacts corrupted?
- Is the search server build actually valid?
- Are there missing dependencies in plugin/scripts/node_modules?

## Likely Root Causes (Untested)

Based on evidence:
1. **Build artifacts are corrupted** - search-server.mjs threw syntax errors when run
2. **Node modules missing/outdated** - plugin/scripts/node_modules may be stale
3. **ESM/CJS bundling issue** - esbuild may have produced invalid output
4. **search-everything branch has broken build config** - scripts/build-hooks.js may have issues

## Key Lessons

### KISS/DRY/YAGNI Violations
- Added complexity (disabling features) instead of removing it
- Tried to work around symptoms instead of fixing root cause
- Ignored the principle: "If it worked before and code is same, it's environment/build"

### Debugging Anti-Patterns
1. **Symptom Chasing**: Following error messages down rabbit holes
2. **Defensive Coding**: Commenting out "broken" features instead of fixing them
3. **Ignoring History**: Not comparing working vs broken states
4. **Build Blindness**: Assuming built artifacts are correct without verification

### What Good Debugging Looks Like
1. Compare working state (main) vs broken state (current branch)
2. Identify what actually changed (code? deps? build?)
3. Test the simplest hypothesis first (build issue vs code issue)
4. Never disable features to "fix" things - that's not fixing

## Action Items for Next Attempt

### Before Writing Any Code:
- [ ] `git diff main` for all modified files
- [ ] Check if `plugin/scripts/` artifacts are valid JavaScript
- [ ] Compare build process: `npm run build` output on main vs current branch
- [ ] Verify `plugin/scripts/node_modules` exists and is current
- [ ] Test search-server.mjs in isolation: `node plugin/scripts/search-server.mjs`

### If Build is Broken:
- [ ] Check scripts/build-hooks.js for recent changes
- [ ] Verify esbuild configuration
- [ ] Test build on main branch, then on current branch
- [ ] Don't modify source code until build is proven working

### If Code is Broken:
- [ ] Create minimal repro (which specific change broke it?)
- [ ] Fix the actual bug, don't add workarounds
- [ ] Test the fix in isolation

## Conclusion

This failure exemplifies "debugging by making changes" instead of "debugging by understanding". The instinct to fix symptoms (MCP errors) instead of investigating root cause (why is it broken now?) led to wasted effort and ultimately no solution.

The user's frustration was justified - I was adding defensive duct tape instead of finding and fixing the real problem. This is exactly what KISS/DRY/YAGNI principles are meant to prevent.

**Next time: Compare, verify, understand, THEN fix. Never disable features to make errors go away.**
