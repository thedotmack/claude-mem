  Plan: Make Claude-Mem Cowork & Marketplace Compatible                                                                                                   
                                                                                                                                                          
  Phase 0: Documentation Discovery (Complete)                                                                                                             
                                                                                                                                                          
  Allowed APIs / Variables                                                                                                                                
                                                                                                                                                          
  ┌───────────────────────┬────────────────────────────┬──────────────────────────────────────────────────────────────┬──────────────────────────────┐    
  │       Variable        │          Works In          │                       Doesn't Work In                        │            Source            │
  ├───────────────────────┼────────────────────────────┼──────────────────────────────────────────────────────────────┼──────────────────────────────┤    
  │ ${CLAUDE_PLUGIN_ROOT} │ hooks.json commands,       │ Skill/Command markdown (Issue #9354), SessionStart hooks     │ Plugins Reference + GitHub   │
  │                       │ .mcp.json                  │ (Issue #24529)                                               │ Issues                       │
  ├───────────────────────┼────────────────────────────┼──────────────────────────────────────────────────────────────┼──────────────────────────────┤    
  │ ${CLAUDE_SKILL_DIR}   │ Skill SKILL.md files       │ Hooks, commands                                              │ Skills docs                  │
  ├───────────────────────┼────────────────────────────┼──────────────────────────────────────────────────────────────┼──────────────────────────────┤    
  │ $ARGUMENTS            │ Skill SKILL.md files       │ —                                                            │ Skills docs                  │
  ├───────────────────────┼────────────────────────────┼──────────────────────────────────────────────────────────────┼──────────────────────────────┤    
  │ CLAUDE_PROJECT_DIR    │ All hooks                  │ —                                                            │ Hooks Reference              │
  └───────────────────────┴────────────────────────────┴──────────────────────────────────────────────────────────────┴──────────────────────────────┘    
                                                                                   
  Critical Bug Context                                                                                                                                    
                                                                                   
  - Issue #24529 (OPEN): CLAUDE_PLUGIN_ROOT is NOT set for SessionStart hooks. This means our fallback path IS hit on every session start.                
  - Issue #9354 (OPEN): CLAUDE_PLUGIN_ROOT is NOT expanded in skill/command markdown. Skills must use ${CLAUDE_SKILL_DIR} instead.
                                                                                                                                                          
  Path Reality                                                                     
                                                                                                                                                          
  ┌───────────────────┬──────────────────────────────────────────────────────────┐                                                                        
  │      Context      │                       Install Path                       │
  ├───────────────────┼──────────────────────────────────────────────────────────┤                                                                        
  │ Developer (rsync) │ ~/.claude/plugins/marketplaces/thedotmack/plugin/        │ 
  ├───────────────────┼──────────────────────────────────────────────────────────┤
  │ Marketplace cache │ ~/.claude/plugins/cache/thedotmack/claude-mem/<version>/ │                                                                        
  ├───────────────────┼──────────────────────────────────────────────────────────┤                                                                        
  │ --plugin-dir      │ Wherever user points it                                  │                                                                        
  └───────────────────┴──────────────────────────────────────────────────────────┘                                                                        
                                                                                   
  Our current fallback $HOME/.claude/plugins/marketplaces/thedotmack/plugin only works for the developer. Cache-installed users hit a broken path on every
   SessionStart.                                                                   
                                                                                                                                                          
  Anti-Patterns to Avoid                                                           
                                                    
  - Do NOT use ${CLAUDE_PLUGIN_ROOT} in SKILL.md or command .md files — it won't expand                                                                   
  - Do NOT hardcode marketplaces/thedotmack anywhere — cache installs use a different path
  - Do NOT assume scripts can find their plugin root from env vars alone in SessionStart hooks                                                            
                                                                                                                                                          
  ---                                                                                                                                                     
  Phase 1: Fix hooks.json Fallback Path                                                                                                                   
                                                                                                                                                          
  Problem: When CLAUDE_PLUGIN_ROOT is empty (SessionStart bug #24529), hooks fall back to a hardcoded path that only exists on the developer's machine.
                                                                                                                                                          
  What to implement:                                                               
                                                                                                                                                          
  Replace the fallback strategy in all 8 hook commands. Since hooks.json lives inside the plugin directory, and Claude Code copies it to cache, we can    
  derive the plugin root from the hooks.json location using a creative approach:
                                                                                                                                                          
  The hook commands call scripts like node "$_R/scripts/bun-runner.js". The scripts themselves already handle path resolution via __dirname (confirmed in 
  bun-runner.js:22-28 and smart-install.js:46-68). The problem is only getting to the script in the first place.
                                                                                                                                                          
  Approach: Since we can't use __dirname in a shell snippet, add a second fallback that searches the cache directory:                                     
                                                    
  _R="${CLAUDE_PLUGIN_ROOT}";                                                                                                                             
  [ -z "$_R" ] && _R="$(ls -d "$HOME/.claude/plugins/cache/thedotmack/claude-mem/"*/  2>/dev/null | tail -1)";                                            
  [ -z "$_R" ] && _R="$HOME/.claude/plugins/marketplaces/thedotmack/plugin";                                                                              
                                                                                                                                                          
  This adds a cache-path fallback between CLAUDE_PLUGIN_ROOT and the dev-machine fallback.                                                                
                                                                                                                                                          
  Files to modify:                                                                                                                                        
  - plugin/hooks/hooks.json — all 8 hook commands                                  
                                                                                                                                                          
  Verification:
  - grep -c 'cache/thedotmack' plugin/hooks/hooks.json should return 8                                                                                    
  - grep -c 'marketplaces/thedotmack' plugin/hooks/hooks.json should still return 8 (kept as last resort)                                                 
  - Build passes: npm run build-and-sync                                                                 
                                                                                                                                                          
  ---                                                                                                                                                     
  Phase 2: Fix Skills to Use ${CLAUDE_SKILL_DIR}                                                                                                          
                                                                                                                                                          
  Problem: /set-mode and /mode hardcode ~/.claude/plugins/marketplaces/thedotmack/plugin/ for mode file lookup and worker restart. CLAUDE_PLUGIN_ROOT
  doesn't work in skill markdown (Issue #9354).                                                                                                           
                                                                                   
  What to implement:                                                                                                                                      
                                                                                   
  ${CLAUDE_SKILL_DIR} resolves to the skill's subdirectory (e.g., .../skills/set-mode/). To reach the plugin root from a skill, navigate up:              
  ${CLAUDE_SKILL_DIR}/../../.
                                                                                                                                                          
  File 1: plugin/skills/set-mode/SKILL.md                                                                                                                 
                                                    
  Step 1 (mode file lookup) — Replace:                                                                                                                    
  1. `~/.claude/plugins/marketplaces/thedotmack/plugin/modes/$ARGUMENTS.json` (installed plugin)
  With:                                                                                                                                                   
  1. `${CLAUDE_SKILL_DIR}/../../modes/$ARGUMENTS.json` (installed plugin)                                                                                 
                                                                                                                                                          
  Step 5 (worker restart) — Replace:                                                                                                                      
  bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-cli.js restart                                                                      
  With:                                                                            
  bun "${CLAUDE_SKILL_DIR}/../../scripts/worker-cli.js" restart                                                                                           
                                                                                   
  File 2: plugin/commands/mode.md                                                                                                                         
                                                                                                                                                          
  Line 20 — Replace:                                
  Glob pattern: plugin/modes/*.json (relative to CLAUDE_PLUGIN_ROOT or ~/.claude/plugins/marketplaces/thedotmack/plugin/modes/)                           
  With:                                                                            
  Glob pattern: Look for mode JSON files. Try globbing `${CLAUDE_SKILL_DIR}/../../modes/*.json` first (installed plugin), then `plugin/modes/*.json`      
  (development repo).
                                                                                                                                                          
  Verification:                                                                                                                                           
  - grep 'marketplaces/thedotmack' plugin/skills/set-mode/SKILL.md should return 0 matches
  - grep 'marketplaces/thedotmack' plugin/commands/mode.md should return 0 matches                                                                        
  - grep 'CLAUDE_SKILL_DIR' plugin/skills/set-mode/SKILL.md should return matches  
  - Manually test /set-mode cowork and /mode from a cache-installed plugin                                                                                
                                                                                                                                                          
  ---                                                                                                                                                     
  Phase 3: Fix Error Messages in Source                                                                                                                   
                                                                                                                                                          
  Problem: CursorHooksInstaller.ts shows hardcoded paths in error messages. BranchManager.ts has a hardcoded path in a comment.
                                                                                                                                                          
  What to implement:                                                                                                                                      
                                                                                                                                                          
  File 1: src/services/integrations/CursorHooksInstaller.ts                                                                                               
                                                                                   
  Replace error messages at lines ~240 and ~309:                                                                                                          
  // Before                                                                        
  console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');                                               
                                                                                                                                                          
  // After                                                                                                                                                
  console.error('   Expected in plugin scripts directory (check CLAUDE_PLUGIN_ROOT or marketplace install)');                                             
                                                                                                                                                          
  File 2: src/services/worker/BranchManager.ts                                                                                                            
                                                                                                                                                          
  Line 5 — Update comment to remove hardcoded path.                                                                                                       
                                                                                                                                                          
  Verification:                                                                                                                                           
  - grep -r 'marketplaces/thedotmack' src/ should only return src/shared/paths.ts (the one intentional constant)
  - Build passes: npm run build-and-sync                                                                                                                  
                                                                                   
  ---                                                                                                                                                     
  Phase 4: Fix worker-cli.js Path Resolution                                       
                                                                                                                                                          
  Problem: The minified worker-cli.js hardcodes join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack') for finding the worker script.
                                                                                                                                                          
  What to implement:
                                                                                                                                                          
  Find the source file for worker-cli.js (likely src/services/worker/worker-cli.ts or similar). Update it to:                                             
  1. Check CLAUDE_PLUGIN_ROOT env var first         
  2. Check cache directory second                                                                                                                         
  3. Fall back to marketplace path last                                            
                                                                                                                                                          
  This follows the same priority as smart-install.js:46-68 which already implements this correctly.
                                                                                                                                                          
  Verification:
  - Build and verify worker-cli.js no longer has a single hardcoded marketplace path as its only resolution                                               
  - Test bun plugin/scripts/worker-cli.js restart from dev environment                                                                                    
  - Test from cache-installed location                                
                                                                                                                                                          
  ---                                                                                                                                                     
  Phase 5: Verification & Testing                                                                                                                         
                                                                                                                                                          
  1. Path audit: grep -r 'marketplaces/thedotmack' plugin/ — should only appear in hooks.json (as last-resort fallback) and nowhere in skills/commands
  2. Build: npm run build-and-sync                                                                                                                        
  3. Functional test: Start a new Claude Code session, verify:                                                                                            
    - Worker starts (SessionStart hook fires successfully)                                                                                                
    - Context loads (context hook returns data)                                                                                                           
    - /mode lists modes                                                                                                                                   
    - /set-mode cowork switches modes                                                                                                                     
  4. Cache install test: Install from marketplace, verify same functionality from cache path
  5. Anti-pattern grep: grep -rn 'CLAUDE_PLUGIN_ROOT' plugin/skills/ plugin/commands/ should return 0 (use CLAUDE_SKILL_DIR instead)                      
                               