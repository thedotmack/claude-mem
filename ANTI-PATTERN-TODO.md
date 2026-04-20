# Anti-Pattern Fix Checklist

**Total: 301 issues | Fixed: 289 | Approved Overrides: 12 | Remaining: 0**
**Detector passes clean: 0 issues to fix**

Every item gets fixed (logging added, try block narrowed, catch made specific, or error propagated) OR approved with a specific technical reason.

---

## src/services/worker-service.ts (14 issues)
- [x] :291 GENERIC_CATCH
- [x] :291 CATCH_AND_CONTINUE_CRITICAL_PATH
- [x] :375 LARGE_TRY_BLOCK
- [x] :388 GENERIC_CATCH
- [x] :388 CATCH_AND_CONTINUE_CRITICAL_PATH
- [x] :489 CATCH_AND_CONTINUE_CRITICAL_PATH
- [x] :536 CATCH_AND_CONTINUE_CRITICAL_PATH
- [x] :574 LARGE_TRY_BLOCK
- [x] :592 GENERIC_CATCH
- [x] :592 CATCH_AND_CONTINUE_CRITICAL_PATH
- [x] :696 ERROR_MESSAGE_GUESSING
- [x] :837 CATCH_AND_CONTINUE_CRITICAL_PATH
- [x] :849 CATCH_AND_CONTINUE_CRITICAL_PATH
- [x] :912 LARGE_TRY_BLOCK
- [x] :941 GENERIC_CATCH
- [x] :941 CATCH_AND_CONTINUE_CRITICAL_PATH
- [x] :961 LARGE_TRY_BLOCK
- [x] :979 GENERIC_CATCH
- [x] :979 CATCH_AND_CONTINUE_CRITICAL_PATH

## src/services/sqlite/SessionStore.ts (7 issues)
- [x] :449 LARGE_TRY_BLOCK
- [x] :477 GENERIC_CATCH
- [x] :477 CATCH_AND_CONTINUE_CRITICAL_PATH
- [x] :689 LARGE_TRY_BLOCK
- [x] :848 GENERIC_CATCH
- [x] :2302 GENERIC_CATCH
- [x] :2334 GENERIC_CATCH

## src/services/worker/SDKAgent.ts (1 issue)
- [x] :481 GENERIC_CATCH

## src/services/worker/GeminiAgent.ts (1 issue)
- [x] :138 LARGE_TRY_BLOCK

## src/services/worker/OpenRouterAgent.ts (1 issue)
- [x] :87 LARGE_TRY_BLOCK

## src/services/infrastructure/ProcessManager.ts (20 issues)
- [x] :56 LARGE_TRY_BLOCK
- [x] :69 NO_LOGGING_IN_CATCH
- [x] :205 GENERIC_CATCH
- [x] :219 GENERIC_CATCH
- [x] :263 GENERIC_CATCH
- [x] :290 GENERIC_CATCH
- [x] :307 GENERIC_CATCH
- [x] :307 NO_LOGGING_IN_CATCH (APPROVED OVERRIDE exists — review)
- [x] :375 LARGE_TRY_BLOCK
- [x] :443 GENERIC_CATCH
- [x] :470 GENERIC_CATCH
- [x] :479 GENERIC_CATCH
- [x] :525 LARGE_TRY_BLOCK
- [x] :608 GENERIC_CATCH
- [x] :628 GENERIC_CATCH
- [x] :636 GENERIC_CATCH
- [x] :751 LARGE_TRY_BLOCK
- [x] :828 GENERIC_CATCH
- [x] :899 GENERIC_CATCH
- [x] :963 NO_LOGGING_IN_CATCH
- [x] :963 GENERIC_CATCH
- [x] :986 NO_LOGGING_IN_CATCH
- [x] :1035 GENERIC_CATCH

## src/services/infrastructure/HealthMonitor.ts (3 issues)
- [x] :56 NO_LOGGING_IN_CATCH
- [x] :93 GENERIC_CATCH
- [x] :168 GENERIC_CATCH

## src/services/infrastructure/WorktreeAdoption.ts (3 issues)
- [x] :253 LARGE_TRY_BLOCK
- [x] :285 GENERIC_CATCH
- [x] :301 GENERIC_CATCH

## src/services/worker/SessionManager.ts (5 issues)
- [x] :72 NO_LOGGING_IN_CATCH
- [x] :294 GENERIC_CATCH
- [x] :345 GENERIC_CATCH
- [x] :399 GENERIC_CATCH
- [x] :471 GENERIC_CATCH

## src/services/worker/ProcessRegistry.ts (2 issues)
- [x] :398 NO_LOGGING_IN_CATCH
- [x] :497 GENERIC_CATCH

## src/services/worker/SearchManager.ts (8 issues)
- [x] :442 LARGE_TRY_BLOCK
- [x] :458 GENERIC_CATCH
- [x] :692 LARGE_TRY_BLOCK
- [x] :726 GENERIC_CATCH
- [x] :766 LARGE_TRY_BLOCK
- [x] :794 GENERIC_CATCH
- [x] :1375 GENERIC_CATCH
- [x] :1390 GENERIC_CATCH

## src/services/worker/BranchManager.ts (5 issues)
- [x] :121 LARGE_TRY_BLOCK
- [x] :139 GENERIC_CATCH
- [x] :244 GENERIC_CATCH
- [x] :269 LARGE_TRY_BLOCK
- [x] :301 GENERIC_CATCH

## src/services/worker/SettingsManager.ts (1 issue)
- [x] :45 GENERIC_CATCH

## src/services/worker/PaginationHelper.ts (1 issue)
- [x] :57 GENERIC_CATCH

## src/services/worker/knowledge/KnowledgeAgent.ts (4 issues)
- [x] :94 GENERIC_CATCH
- [x] :133 GENERIC_CATCH
- [x] :206 GENERIC_CATCH
- [x] :261 GENERIC_CATCH

## src/services/worker/knowledge/CorpusStore.ts (2 issues)
- [x] :48 GENERIC_CATCH
- [x] :75 GENERIC_CATCH

## src/services/worker/knowledge/CorpusBuilder.ts (1 issue)
- [x] :26 NO_LOGGING_IN_CATCH

## src/services/worker/http/BaseRouteHandler.ts (1 issue)
- [x] :29 GENERIC_CATCH

## src/services/worker/http/routes/SearchRoutes.ts (2 issues)
- [x] :272 LARGE_TRY_BLOCK
- [x] :297 GENERIC_CATCH

## src/services/worker/http/routes/SettingsRoutes.ts (1 issue)
- [x] :76 GENERIC_CATCH

## src/services/worker/http/routes/SessionRoutes.ts (5 issues)
- [x] :223 PROMISE_CATCH_NO_LOGGING
- [x] :259 GENERIC_CATCH
- [x] :288 LARGE_TRY_BLOCK
- [x] :589 LARGE_TRY_BLOCK
- [x] :643 GENERIC_CATCH

## src/services/worker/http/routes/CorpusRoutes.ts (1 issue)
- [x] :96 NO_LOGGING_IN_CATCH

## src/services/worker/http/routes/ViewerRoutes.ts (1 issue)
- [x] :74 NO_LOGGING_IN_CATCH

## src/services/worker/search/strategies/ChromaSearchStrategy.ts (2 issues)
- [x] :66 LARGE_TRY_BLOCK
- [x] :140 GENERIC_CATCH

## src/services/worker/search/strategies/HybridSearchStrategy.ts (6 issues)
- [x] :71 LARGE_TRY_BLOCK
- [x] :113 GENERIC_CATCH
- [x] :137 LARGE_TRY_BLOCK
- [x] :178 GENERIC_CATCH
- [x] :204 LARGE_TRY_BLOCK
- [x] :244 GENERIC_CATCH

## src/services/worker/search/strategies/SQLiteSearchStrategy.ts (2 issues)
- [x] :67 LARGE_TRY_BLOCK
- [x] :99 GENERIC_CATCH

## src/services/queue/SessionQueueProcessor.ts (2 issues)
- [x] :37 LARGE_TRY_BLOCK
- [x] :67 GENERIC_CATCH

## src/services/sync/ChromaMcpManager.ts (6 issues)
- [x] :79 GENERIC_CATCH
- [x] :310 NO_LOGGING_IN_CATCH
- [x] :325 NO_LOGGING_IN_CATCH
- [x] :344 GENERIC_CATCH
- [x] :397 NO_LOGGING_IN_CATCH
- [x] :411 NO_LOGGING_IN_CATCH

## src/services/sync/ChromaSync.ts (5 issues)
- [x] :565 LARGE_TRY_BLOCK
- [x] :731 LARGE_TRY_BLOCK
- [x] :788 ERROR_STRING_MATCHING
- [x] :789 ERROR_STRING_MATCHING
- [x] :828 GENERIC_CATCH

## src/services/context/ContextBuilder.ts (1 issue)
- [x] :52 GENERIC_CATCH

## src/services/context/ObservationCompiler.ts (2 issues)
- [x] :228 LARGE_TRY_BLOCK
- [x] :248 GENERIC_CATCH

## src/services/server/Server.ts (3 issues)
- [x] :211 LARGE_TRY_BLOCK
- [x] :235 NO_LOGGING_IN_CATCH
- [x] :235 GENERIC_CATCH

## src/services/worker-spawner.ts (1 issue)
- [x] :56 NO_LOGGING_IN_CATCH

## src/services/smart-file-read/search.ts (2 issues)
- [x] :81 NO_LOGGING_IN_CATCH
- [x] :117 NO_LOGGING_IN_CATCH

## src/services/smart-file-read/parser.ts (5 issues)
- [x] :162 NO_LOGGING_IN_CATCH
- [x] :277 NO_LOGGING_IN_CATCH
- [x] :284 NO_LOGGING_IN_CATCH
- [x] :553 NO_LOGGING_IN_CATCH
- [x] :588 NO_LOGGING_IN_CATCH

## src/services/sqlite/migrations/runner.ts (4 issues)
- [x] :421 LARGE_TRY_BLOCK
- [x] :449 GENERIC_CATCH
- [x] :661 LARGE_TRY_BLOCK
- [x] :817 GENERIC_CATCH

## src/services/sqlite/migrations.ts (1 issue)
- [x] :381 NO_LOGGING_IN_CATCH

## src/services/sqlite/observations/files.ts (1 issue)
- [x] :20 NO_LOGGING_IN_CATCH

## src/services/sqlite/timeline/queries.ts (2 issues)
- [x] :114 GENERIC_CATCH
- [x] :146 GENERIC_CATCH

## src/services/sqlite/SessionSearch.ts (5 issues)
- [x] :77 LARGE_TRY_BLOCK
- [x] :161 GENERIC_CATCH
- [x] :176 NO_LOGGING_IN_CATCH
- [x] :384 NO_LOGGING_IN_CATCH
- [x] :402 NO_LOGGING_IN_CATCH

## src/services/transcripts/watcher.ts (4 issues)
- [x] :46 NO_LOGGING_IN_CATCH
- [x] :155 NO_LOGGING_IN_CATCH
- [x] :183 NO_LOGGING_IN_CATCH
- [x] :219 GENERIC_CATCH

## src/services/transcripts/processor.ts (3 issues)
- [x] :280 NO_LOGGING_IN_CATCH
- [x] :325 LARGE_TRY_BLOCK
- [x] :355 LARGE_TRY_BLOCK

## src/services/transcripts/field-utils.ts (1 issue)
- [x] :145 NO_LOGGING_IN_CATCH

## src/services/integrations/CursorHooksInstaller.ts (11 issues)
- [x] :118 GENERIC_CATCH
- [x] :260 GENERIC_CATCH
- [x] :311 LARGE_TRY_BLOCK
- [x] :381 GENERIC_CATCH
- [x] :402 LARGE_TRY_BLOCK
- [x] :419 GENERIC_CATCH
- [x] :459 LARGE_TRY_BLOCK
- [x] :503 GENERIC_CATCH
- [x] :538 LARGE_TRY_BLOCK
- [x] :565 NO_LOGGING_IN_CATCH
- [x] :602 GENERIC_CATCH

## src/services/integrations/GeminiCliHooksInstaller.ts (6 issues)
- [x] :164 GENERIC_CATCH
- [x] :289 LARGE_TRY_BLOCK
- [x] :334 GENERIC_CATCH
- [x] :350 LARGE_TRY_BLOCK
- [x] :403 GENERIC_CATCH
- [x] :427 NO_LOGGING_IN_CATCH
- [x] :427 GENERIC_CATCH

## src/services/integrations/OpenCodeInstaller.ts (3 issues)
- [x] :166 LARGE_TRY_BLOCK
- [x] :214 LARGE_TRY_BLOCK
- [x] :312 LARGE_TRY_BLOCK

## src/services/integrations/OpenClawInstaller.ts (2 issues)
- [x] :149 NO_LOGGING_IN_CATCH
- [x] :253 LARGE_TRY_BLOCK

## src/services/integrations/WindsurfHooksInstaller.ts (13 issues)
- [x] :88 GENERIC_CATCH
- [x] :152 GENERIC_CATCH
- [x] :237 GENERIC_CATCH
- [x] :289 LARGE_TRY_BLOCK
- [x] :321 GENERIC_CATCH
- [x] :337 LARGE_TRY_BLOCK
- [x] :352 GENERIC_CATCH
- [x] :386 LARGE_TRY_BLOCK
- [x] :409 NO_LOGGING_IN_CATCH
- [x] :409 GENERIC_CATCH
- [x] :448 LARGE_TRY_BLOCK
- [x] :459 NO_LOGGING_IN_CATCH

## src/services/integrations/McpIntegrations.ts (4 issues)
- [x] :108 LARGE_TRY_BLOCK
- [x] :148 GENERIC_CATCH
- [x] :277 LARGE_TRY_BLOCK
- [x] :337 GENERIC_CATCH

## src/services/integrations/CodexCliInstaller.ts (9 issues)
- [x] :69 GENERIC_CATCH
- [x] :138 LARGE_TRY_BLOCK
- [x] :161 GENERIC_CATCH
- [x] :187 LARGE_TRY_BLOCK
- [x] :216 GENERIC_CATCH
- [x] :237 LARGE_TRY_BLOCK
- [x] :265 GENERIC_CATCH
- [x] :291 LARGE_TRY_BLOCK
- [x] :337 NO_LOGGING_IN_CATCH

## src/services/domain/ModeManager.ts (3 issues)
- [x] :146 GENERIC_CATCH
- [x] :163 GENERIC_CATCH
- [x] :173 GENERIC_CATCH

## src/supervisor/process-registry.ts (5 issues)
- [x] :35 NO_LOGGING_IN_CATCH
- [x] :35 GENERIC_CATCH
- [x] :68 GENERIC_CATCH
- [x] :170 GENERIC_CATCH
- [x] :197 GENERIC_CATCH

## src/supervisor/shutdown.ts (6 issues)
- [x] :38 GENERIC_CATCH
- [x] :52 GENERIC_CATCH
- [x] :71 GENERIC_CATCH
- [x] :94 GENERIC_CATCH
- [x] :139 GENERIC_CATCH
- [x] :154 NO_LOGGING_IN_CATCH

## src/supervisor/index.ts (2 issues)
- [x] :72 GENERIC_CATCH
- [x] :164 GENERIC_CATCH

## src/cli/hook-command.ts (1 issue)
- [x] :75 LARGE_TRY_BLOCK

## src/cli/stdin-reader.ts (4 issues)
- [x] :32 NO_LOGGING_IN_CATCH
- [x] :52 NO_LOGGING_IN_CATCH
- [x] :131 LARGE_TRY_BLOCK
- [x] :170 NO_LOGGING_IN_CATCH

## src/cli/claude-md-commands.ts (12 issues)
- [x] :79 LARGE_TRY_BLOCK
- [x] :97 GENERIC_CATCH
- [x] :144 NO_LOGGING_IN_CATCH
- [x] :190 NO_LOGGING_IN_CATCH
- [x] :203 NO_LOGGING_IN_CATCH
- [x] :319 LARGE_TRY_BLOCK
- [x] :345 NO_LOGGING_IN_CATCH
- [x] :345 GENERIC_CATCH
- [x] :357 LARGE_TRY_BLOCK
- [x] :430 GENERIC_CATCH
- [x] :508 LARGE_TRY_BLOCK
- [x] :525 GENERIC_CATCH

## src/cli/handlers/session-complete.ts (2 issues)
- [x] :38 LARGE_TRY_BLOCK
- [x] :58 GENERIC_CATCH

## src/cli/handlers/user-message.ts (1 issue)
- [x] :28 LARGE_TRY_BLOCK

## src/cli/handlers/context.ts (1 issue)
- [x] :48 LARGE_TRY_BLOCK

## src/cli/handlers/file-context.ts (3 issues)
- [x] :202 NO_LOGGING_IN_CATCH
- [x] :202 GENERIC_CATCH
- [x] :221 LARGE_TRY_BLOCK

## src/cli/handlers/summarize.ts (1 issue)
- [x] :111 LARGE_TRY_BLOCK

## src/cli/handlers/session-init.ts (1 issue)
- [x] :134 LARGE_TRY_BLOCK

## src/cli/handlers/file-edit.ts (1 issue)
- [x] :41 LARGE_TRY_BLOCK

## src/cli/handlers/observation.ts (1 issue)
- [x] :50 LARGE_TRY_BLOCK

## src/ui/viewer/hooks/useStats.ts (1 issue)
- [x] :13 GENERIC_CATCH

## src/ui/viewer/hooks/useTheme.ts (2 issues)
- [x] :19 GENERIC_CATCH
- [x] :64 GENERIC_CATCH

## src/ui/viewer/hooks/useContextPreview.ts (3 issues)
- [x] :40 LARGE_TRY_BLOCK
- [x] :63 GENERIC_CATCH
- [x] :108 NO_LOGGING_IN_CATCH

## src/bin/import-xml-observations.ts (7 issues)
- [x] :62 LARGE_TRY_BLOCK
- [x] :134 LARGE_TRY_BLOCK
- [x] :152 GENERIC_CATCH
- [x] :167 LARGE_TRY_BLOCK
- [x] :183 GENERIC_CATCH
- [x] :329 GENERIC_CATCH
- [x] :361 GENERIC_CATCH

## src/utils/project-filter.ts (1 issue)
- [x] :66 NO_LOGGING_IN_CATCH

## src/utils/worktree.ts (2 issues)
- [x] :41 NO_LOGGING_IN_CATCH
- [x] :55 NO_LOGGING_IN_CATCH

## src/utils/claude-md-utils.ts (2 issues)
- [x] :442 LARGE_TRY_BLOCK
- [x] :475 GENERIC_CATCH

## src/utils/logger.ts (5 issues)
- [x] :63 GENERIC_CATCH
- [x] :87 NO_LOGGING_IN_CATCH
- [x] :87 GENERIC_CATCH
- [x] :155 NO_LOGGING_IN_CATCH
- [x] :292 GENERIC_CATCH

## src/utils/json-utils.ts (1 issue)
- [x] :24 GENERIC_CATCH

## src/utils/agents-md-utils.ts (1 issue)
- [x] :34 GENERIC_CATCH

## src/shared/timeline-formatting.ts (1 issue)
- [x] :19 GENERIC_CATCH

## src/shared/plugin-state.ts (1 issue)
- [x] :25 NO_LOGGING_IN_CATCH

## src/shared/worker-utils.ts (2 issues)
- [x] :150 GENERIC_CATCH
- [x] :179 LARGE_TRY_BLOCK

## src/shared/SettingsDefaultsManager.ts (2 issues)
- [x] :224 GENERIC_CATCH
- [x] :244 GENERIC_CATCH

## src/shared/EnvManager.ts (3 issues)
- [x] :124 GENERIC_CATCH
- [x] :134 LARGE_TRY_BLOCK
- [x] :186 GENERIC_CATCH

## src/shared/paths.ts (1 issue)
- [x] :149 GENERIC_CATCH

## src/sdk/prompts.ts (2 issues)
- [x] :112 GENERIC_CATCH
- [x] :121 GENERIC_CATCH

## src/npx-cli/utils/bun-resolver.ts (1 issue)
- [x] :82 NO_LOGGING_IN_CATCH

## src/npx-cli/commands/install.ts (4 issues)
- [x] :131 NO_LOGGING_IN_CATCH
- [x] :375 NO_LOGGING_IN_CATCH
- [x] :412 NO_LOGGING_IN_CATCH
- [x] :501 NO_LOGGING_IN_CATCH

## src/npx-cli/commands/uninstall.ts (1 issue)
- [x] :123 NO_LOGGING_IN_CATCH

## src/npx-cli/commands/runtime.ts (2 issues)
- [x] :157 LARGE_TRY_BLOCK
- [x] :177 GENERIC_CATCH

## src/npx-cli/commands/ide-detection.ts (2 issues)
- [x] :41 NO_LOGGING_IN_CATCH
- [x] :56 NO_LOGGING_IN_CATCH

## src/servers/mcp-server.ts (4 issues)
- [x] :111 LARGE_TRY_BLOCK
- [x] :156 LARGE_TRY_BLOCK
- [x] :198 GENERIC_CATCH
- [x] :232 GENERIC_CATCH

## src/integrations/opencode-plugin/index.ts (3 issues)
- [x] :108 LARGE_TRY_BLOCK
- [x] :342 LARGE_TRY_BLOCK
- [x] :357 NO_LOGGING_IN_CATCH
