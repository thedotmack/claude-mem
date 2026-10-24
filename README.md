# claude-mem — LeoLi-Goat personal fork

基于 claude-mem 15.0.2，保留本地记忆能力，为个人使用做少量改造。原项目由 Alex Newman 创建，沿用 Apache-2.0 许可证，版权及第三方声明见 LICENSE 和 NOTICE。

这个分支的约定：

- 日常会话、欢迎提示和本地查看器不展示购买、试用或 TeamBrain 推广。
- 安装不要求 cmem.ai 账号，也不会主动发起云端登录。
- 选择 Claude 时保留已有 gateway / API key / OAuth 认证、模型和凭证文件。
- Claude 插件使用独立来源 `leoli-goat`，Codex 来源为 `claude-mem-leoli-goat`。安装器登记 `autoUpdate: false`，升级由你选择提交后手动执行。
- 继续使用现有 `~/.claude-mem` 数据，不复制、不上传原有记忆。Observer 仍会向你配置的模型服务发送需要总结的内容。
- 原有云同步和其他 provider 的代码仍在；本 fork 不会自动启用它们。已有云同步设置会保留，安装不会替你关闭它。

## 从源码安装到 Mac

需要 Git、Node.js 20.12+ 和 Bun 1.4.2。语义搜索还需要 uv/uvx 及 Chroma；它们的首次下载与模型认证是独立问题。

```sh
git clone https://github.com/LeoLi-Goat/claude-mem.git
cd claude-mem
# 先切到你审阅并决定使用的分支或提交。
bun install --frozen-lockfile
bun run typecheck
bun run fork:install
```

`fork:install` 只构建当前检出的代码，不拉取新版本。它先创建仅当前用户可读的数据库及配置备份，然后安装到独立目录，并关闭旧 `claude-mem@thedotmack` 的启用状态，避免重复捕获。旧插件文件保留，方便回退。安装器会等待旧 Worker 停止再覆盖运行文件；安装失败时不要继续下一步。

这个安装入口只迁移 Claude Code。若同时在 Codex 或其他客户端使用 claude-mem，请关闭旧版本会话，并将其他客户端也切到同一 fork，避免不同版本争用同一 Worker。

安装完成后重启 Claude Code 会话。Worker 会由会话钩子启动；查看器默认在 `http://127.0.0.1:37702`。检查状态可运行：

```sh
bun dist/npx-cli/index.js status
```

自定义 `CLAUDE_MEM_DATA_DIR` 或 `CLAUDE_CONFIG_DIR` 时，备份和安装会使用相应目录。备份位于数据目录的 `backups/personal-fork-*`；其中可能包含凭证，勿提交或分享。

## copilot-api 网关

本 fork 不要求 Anthropic 官方订阅。已经正常工作的配置应继续保留：

- `~/.claude-mem/settings.json` 中 provider 为 `claude`，Claude auth method 为 `gateway`。
- 模型名必须是你的网关实际支持的 ID，不预设 Opus 型号。
- `~/.claude-mem/.env` 中保存网关的 `ANTHROPIC_BASE_URL` 和它要求的认证变量。
- 目录建议权限 700，凭证文件 600。

安装器不会读取并复制 Claude Code 的秘密，也不会改动它的网关地址、令牌和模型配置。新安装请先配置 claude-mem 自己的凭证；不要把真实令牌贴进聊天、日志或仓库。

## 手动升级

先查看上游变化，将需要的修改合并进自己的分支并运行测试。选择要安装的提交后，重新执行 `bun run fork:install`，会再次备份。依赖版本由根目录 `bun.lock` 和 `plugin/bun.lock` 固定；更新依赖时需明确审阅锁文件变化。

不要使用上游 `npx claude-mem@latest install` 或 `npx claude-mem update` 来更新这个 fork，它们会运行 npm 上的上游程序。也不要在插件管理器里手动更新本来源，除非你已经审阅远端提交。此 fork 不能阻止外部程序、管理员或你手动覆盖文件。

根包标记为 private；继承的 npm 发布与安装站点部署流程在此 fork 中不运行。上游贡献者署名、许可证和 NOTICE 保留。

## 回退

先退出使用此 Worker 的会话，执行当前构建的 `bun dist/npx-cli/index.js stop`。在 Claude Code 插件管理器里停用 `claude-mem@leoli-goat` 并重新启用原插件。只有确需恢复数据时，才在 Worker 完全停止后，从相应备份还原数据库、settings.json 和 .env；不要在运行中覆盖数据库。配置备份名与原始文件的对应关系可在 `src/npx-cli/install/personal-backup.ts` 中查看。

## 验证

```sh
bun run typecheck
bun run build
bun test tests/npx-cli/personal-backup.test.ts tests/npx-cli/personal-distribution.test.ts
```

构建会重新生成随插件分发的 Worker、启动钩子和查看器，不能只修改源码而保留旧 bundle。`build-and-sync` 属于开发时修改当前安装的命令；普通检查请使用 `build`。
