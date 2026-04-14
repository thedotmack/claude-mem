# Claude-Mem 安全补丁项目 — 交接文档

## 项目位置
本仓库根目录（克隆后即可使用）

## 项目背景
Claude-mem 是一个 Claude Code 插件，提供跨会话的持久化记忆。本轮工作是对其进行安全加固，防止 token 爆炸、数据库膨胀、OOM、DoS 和 prompt 注入等攻击。

## 已完成的补丁

| 补丁 | 威胁 | 修复内容 | 文件 |
|------|------|---------|------|
| **P1** | Token 爆炸 | full mode 硬上限 500 observations/50 sessions + `MAX_OUTPUT_CHARS=500,000` 输出截断 | `src/services/context/ContextBuilder.ts` |
| **P2** | 数据库膨胀 | 载荷截断 ~50K/~100K 字符 + 轻量工具模式；变量名 `_SIZE`→`_CHARS`，参数 `maxBytes`→`maxChars`；`truncatePayload` 已 export | `src/cli/handlers/observation.ts` |
| **P3** | OOM | JSON body limit 50MB→5MB | `src/services/worker/http/middleware.ts` |
| **P4** | DoS | `rateLimit(300, 60_000)` 挂载到 `/api` 路由（health 端点豁免） | `src/services/worker-service.ts` + `src/services/worker/http/middleware.ts` |
| **P5** | Prompt 注入 | 全路径 tag 转义：`context-injection.ts`（原修）+ `replaceTaggedContent()`（补全）+ `claude-md-commands.ts` 内联副本（补全） | `src/utils/context-injection.ts` + `src/utils/claude-md-utils.ts` + `src/cli/claude-md-commands.ts` |

## 代码变更统计
- 7 个源文件修改，+122 行 / -16 行
- 5 个测试文件在 `tests/patches/` 目录

## 测试状态
```
26 pass / 0 fail
5 test files
框架：Bun test (bun test tests/patches/)
```

## 审查结论（已完成三轮）

### 第一轮审查发现的问题（已全部修复）
1. P4 `rateLimit` 函数已定义但未挂载到路由 → 已修复，挂载到 `/api`
2. P5 只转义闭合标签未转义开放标签 → 已修复，双标签转义
3. P2 变量名 `_SIZE` 暗示字节但实际是字符 → 已重命名为 `_CHARS`
4. P1 无最终输出长度守卫 → 已添加 `MAX_OUTPUT_CHARS = 500_000`
5. P2 `truncatePayload` 参数名 `maxBytes` 与实际语义不符 → 已改为 `maxChars`
6. P2 测试本地重声明函数而非导入 → 已改为 `mock.module` + 实际导入

### 第二轮审查（基于 AionUI 历史错误模式）
- Promise 生命周期管理 ✅ 安全（`fetchWithTimeout` + `try/finally`）
- 功能声称 vs 实际实现 ✅ 全部功能已实现且被调用
- 测试覆盖 ✅ 充分（mock.module + 端到端验证）
- **结论：无阻塞性问题，代码可提交**

### 第三轮审查（Codex 独立审核 — P5 攻击面补全）
- **发现 P5 FAIL**：原补丁只修了 `context-injection.ts`，但 `replaceTaggedContent()`（3个调用方）和 `claude-md-commands.ts` 内联副本未做 sanitize
- **修复**：export `sanitizeContextContent` → 在 `replaceTaggedContent()` 和 `claude-md-commands.ts` 两处咽喉点加 sanitize
- **二次审核（Codex）**：验证 3 条 sanitize 路径正确，无双重转义，无遗漏写入路径
- P1 CONCERN（普通模式配置无上限，但有 500K 输出截断兜底）— 可接受
- **结论：全部 5 个补丁通过审核**

## 用户的 AionUI 历史错误模式（供审查参考）
来自 GitHub `iOfficeAI/AionUi` 的 PR #2121 和 #2146：

| # | 模式 | 严重性 |
|---|------|--------|
| 1 | **Promise 生命周期不完整** — 崩溃路径未 reject，Promise 永久 pending | HIGH |
| 2 | **功能声称 vs 实际实现** — 注释声称功能存在但代码未实现 | HIGH |
| 3 | **测试覆盖不足** — 核心新组件 0% 覆盖率 | MEDIUM |
| 4 | **PR 范围过大** — 混合基础设施改动与 UX 修复 | LOW |

## 各补丁验证清单

```
P1: MAX_OUTPUT_CHARS=500_000(ContextBuilder.ts:118) + 截断逻辑(L120-122) ✅
P2: MAX_INPUT_CHARS(L17) + MAX_RESPONSE_CHARS(L18) + LIGHTWEIGHT_INPUT_CHARS(L19) + maxChars参数(L22) ✅
P3: express.json({ limit: '5mb' })(middleware.ts:25) ✅
P4: rateLimit 导入(worker-service.ts:91) + 挂载到 /api(worker-service.ts:301) ✅
P5: sanitizeContextContent export(context-injection.ts:29) ✅
    context-injection.ts:56 调用 sanitize ✅
    replaceTaggedContent(claude-md-utils.ts:107) 调用 sanitize ✅
    writeClaudeMdToFolder(claude-md-commands.ts:285) 调用 sanitize ✅
```

## 待做事项
1. **后续集成** — 将补丁集成到 Claude Code / VSCode / Codex 插件

## 团队运行记录

### 第一轮（开发 + 审查）
- **Developer (Claude)** — 高效，完成全部 6 项修复
- **Reviewer (Claude)** — 质量优秀，两轮审查均有价值
- **Tester (Codex)** — 多次尝试均无产出，不适合此场景
- **Tester (Claude)** — 崩溃

### 第二轮（P5 补全 + 审核）
- **Reviewer (Codex)** — 发现 P5 攻击面遗漏，质量优秀，完成后崩溃
- **Developer (Claude)** — 完成 P5 补全修复（3文件+测试），完成后崩溃
- **Tester (Codex)** — 独立审核 P5 修复通过，完成后崩溃
