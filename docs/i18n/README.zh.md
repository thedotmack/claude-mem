🌐 这是社区维护的翻译。欢迎提交修正！

---

<h1 align="center">
  <br>
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-dark-mode.webp">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-light-mode.webp">
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-light-mode.webp" alt="Claude-Mem" width="400">
    </picture>
  </a>
  <br>
</h1>

**Languages:** [English](../../README.md) · [中文](./README.zh.md) · [Español](./README.es.md) · [Français](./README.fr.md) · [Português](./README.pt-br.md) · [Русский](./README.ru.md) · [Deutsch](./README.de.md)

<h4 align="center">为 <a href="https://claude.com/claude-code" target="_blank">Claude Code</a> 构建的持久化内存压缩系统。</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/version-6.5.0-green.svg" alt="Version">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg" alt="Node">
  </a>
  <a href="https://github.com/thedotmack/awesome-claude-code">
    <img src="https://awesome.re/mentioned-badge.svg" alt="Mentioned in Awesome Claude Code">
  </a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/15496" target="_blank">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/trendshift-badge-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/trendshift-badge.svg">
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/trendshift-badge.svg" alt="thedotmack/claude-mem | Trendshift" width="250" height="55"/>
    </picture>
  </a>
</p>

<br>

<table align="center">
  <tr>
    <td align="center">
      <a href="https://github.com/thedotmack/claude-mem">
        <picture>
          <img
            src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/cm-preview.gif"
            alt="Claude-Mem Preview"
            width="500"
          >
        </picture>
      </a>
    </td>
    <td align="center">
      <a href="https://www.star-history.com/#thedotmack/claude-mem&Date">
        <picture>
          <source
            media="(prefers-color-scheme: dark)"
            srcset="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&theme=dark&legend=top-left"
          />
          <source
            media="(prefers-color-scheme: light)"
            srcset="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&legend=top-left"
          />
          <img
            alt="Star History Chart"
            src="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&legend=top-left"
            width="500"
          />
        </picture>
      </a>
    </td>
  </tr>
</table>

<p align="center">
  <a href="#quick-start">快速开始</a> •
  <a href="#how-it-works">工作原理</a> •
  <a href="#mcp-search-tools">搜索工具</a> •
  <a href="#documentation">文档</a> •
  <a href="#configuration">配置</a> •
  <a href="#troubleshooting">故障排除</a> •
  <a href="#license">许可证</a>
</p>

<p align="center">
  Claude-Mem 通过自动捕获工具使用观察、生成语义摘要并将其提供给后续会话，无缝地在会话之间保留上下文。这使 Claude 即使在会话结束或重新连接后，仍能保持对项目知识的连续性。
</p>

---

## 快速开始

一条命令即可完成安装：

```bash
npx claude-mem install
```

或为 Gemini CLI 安装（自动检测 `~/.gemini`）：

```bash
npx claude-mem install --ide gemini-cli
```
或为 OpenCode 安装：

```bash
npx claude-mem install --ide opencode
```

或在 Claude Code 内通过插件市场安装：

```bash
/plugin marketplace add thedotmack/claude-mem

/plugin install claude-mem
```

重启 Claude Code 或 Gemini CLI。之前会话的上下文将自动出现在新会话中。

> **注意：** Claude-Mem 也发布在 npm 上，但 `npm install -g claude-mem` 仅安装 **SDK/库** — 不会注册插件钩子或设置 worker 服务。请始终通过 `npx claude-mem install` 或上述 `/plugin` 命令安装。

### 🦞 OpenClaw Gateway

通过一条命令在 [OpenClaw](https://openclaw.ai) 网关上安装 claude-mem 作为持久化内存插件：

```bash
curl -fsSL https://install.cmem.ai/openclaw.sh | bash
```

安装程序会处理依赖项、插件设置、AI 提供商配置、worker 启动，以及可选的实时观察推送到 Telegram、Discord、Slack 等。详见 [OpenClaw 集成指南](https://docs.claude-mem.ai/openclaw-integration)。

**主要特性：**

- 🧠 **持久化内存** - 上下文在会话之间保留
- 📊 **渐进式披露** - 分层内存检索，可见 token 成本
- 🔍 **基于技能的搜索** - 使用 mem-search 技能查询项目历史
- 🖥️ **Web 查看器 UI** - 在 http://localhost:37777 实时查看内存流
- 💻 **Claude Desktop 技能** - 从 Claude Desktop 对话中搜索内存
- 🔒 **隐私控制** - 使用 `<private>` 标签排除敏感内容不被存储
- ⚙️ **上下文配置** - 精细控制注入的上下文内容
- 🤖 **自动运行** - 无需手动干预
- 🔗 **引用** - 通过 ID 引用过去的观察（访问 http://localhost:37777/api/observation/{id} 或在 http://localhost:37777 的 Web 查看器中查看全部）
- 🧪 **Beta 频道** - 通过版本切换尝试 Endless Mode 等实验性功能

---

## 文档

📚 **[查看完整文档](https://docs.claude-mem.ai/)** - 在官方网站浏览

### 入门指南

- **[安装指南](https://docs.claude-mem.ai/installation)** - 快速开始与高级安装
- **[Gemini CLI 设置](https://docs.claude-mem.ai/gemini-cli/setup)** - Google Gemini CLI 集成专用指南
- **[使用指南](https://docs.claude-mem.ai/usage/getting-started)** - Claude-Mem 如何自动工作
- **[搜索工具](https://docs.claude-mem.ai/usage/search-tools)** - 用自然语言查询项目历史
- **[Beta 功能](https://docs.claude-mem.ai/beta-features)** - 尝试 Endless Mode 等实验性功能

### 最佳实践

- **[上下文工程](https://docs.claude-mem.ai/context-engineering)** - AI 智能体上下文优化原则
- **[渐进式披露](https://docs.claude-mem.ai/progressive-disclosure)** - Claude-Mem 上下文引导策略背后的理念

### 架构

- **[概览](https://docs.claude-mem.ai/architecture/overview)** - 系统组件与数据流
- **[架构演进](https://docs.claude-mem.ai/architecture-evolution)** - 从 v3 到 v5 的演进历程
- **[Hooks 架构](https://docs.claude-mem.ai/hooks-architecture)** - Claude-Mem 如何使用生命周期钩子
- **[Hooks 参考](https://docs.claude-mem.ai/architecture/hooks)** - 7 个钩子脚本说明
- **[Worker 服务](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API 与 Bun 管理
- **[数据库](https://docs.claude-mem.ai/architecture/database)** - SQLite 模式与 FTS5 搜索
- **[搜索架构](https://docs.claude-mem.ai/architecture/search-architecture)** - 结合 Chroma 向量数据库的混合搜索

### 配置与开发

- **[配置](https://docs.claude-mem.ai/configuration)** - 环境变量与设置
- **[开发](https://docs.claude-mem.ai/development)** - 构建、测试、贡献
- **[故障排除](https://docs.claude-mem.ai/troubleshooting)** - 常见问题与解决方案

---

## 工作原理

**核心组件：**

1. **5 个生命周期钩子** - SessionStart、UserPromptSubmit、PostToolUse、Stop、SessionEnd（6 个钩子脚本）
2. **Smart Install** - 缓存依赖检查器（pre-hook 脚本，非生命周期钩子）
3. **Worker 服务** - 端口 37777 上的 HTTP API，含 Web 查看器 UI 和 10 个搜索端点，由 Bun 管理
4. **SQLite 数据库** - 存储会话、观察、摘要
5. **mem-search 技能** - 支持渐进式披露的自然语言查询
6. **Chroma 向量数据库** - 语义 + 关键词混合搜索，实现智能上下文检索

详见[架构概览](https://docs.claude-mem.ai/architecture/overview)。

---

## MCP 搜索工具

Claude-Mem 通过 **4 个 MCP 工具**提供智能内存搜索，遵循节省 token 的 **三层工作流模式**：

**三层工作流：**

1. **`search`** - 获取带 ID 的紧凑索引（约 50-100 tokens/结果）
2. **`timeline`** - 获取有趣结果周围的 chronological 上下文
3. **`get_observations`** - 仅获取筛选后 ID 的完整详情（约 500-1,000 tokens/结果）

**工作原理：**
- Claude 使用 MCP 工具搜索你的内存
- 从 `search` 开始获取结果索引
- 使用 `timeline` 查看特定观察周围发生了什么
- 使用 `get_observations` 获取相关 ID 的完整详情
- 在获取详情前筛选，**节省约 10 倍 token**

**可用的 MCP 工具：**

1. **`search`** - 全文搜索内存索引，按类型/日期/项目筛选
2. **`timeline`** - 获取特定观察或查询周围的 chronological 上下文
3. **`get_observations`** - 按 ID 获取完整观察详情（始终批量多个 ID）

**使用示例：**

```typescript
// Step 1: Search for index
search(query="authentication bug", type="bugfix", limit=10)

// Step 2: Review index, identify relevant IDs (e.g., #123, #456)

// Step 3: Fetch full details
get_observations(ids=[123, 456])
```

详见[搜索工具指南](https://docs.claude-mem.ai/usage/search-tools)中的详细示例。

---

## Beta 功能

Claude-Mem 提供 **beta 频道**，包含 **Endless Mode**（用于延长会话的仿生内存架构）等实验性功能。可在 http://localhost:37777 → Settings 的 Web 查看器 UI 中切换稳定版与 beta 版。

详见 **[Beta 功能文档](https://docs.claude-mem.ai/beta-features)** 了解 Endless Mode 及如何试用。

---

## 系统要求

- **Node.js**：18.0.0 或更高
- **Claude Code**：支持插件的最新版本
- **Bun**：JavaScript 运行时与进程管理器（缺失时自动安装）
- **uv**：用于向量搜索的 Python 包管理器（缺失时自动安装）
- **SQLite 3**：持久化存储（已捆绑）

---
### Windows 安装说明

如果看到类似错误：

```powershell
npm : The term 'npm' is not recognized as the name of a cmdlet
```

请确保 Node.js 和 npm 已安装并添加到 PATH。从 https://nodejs.org 下载最新 Node.js 安装程序，安装后重启终端。

---

## 配置

设置在 `~/.claude-mem/settings.json` 中管理（首次运行时自动创建默认值）。可配置 AI 模型、worker 端口、数据目录、日志级别和上下文注入设置。

详见 **[配置指南](https://docs.claude-mem.ai/configuration)** 了解所有可用设置与示例。

### 模式与语言配置

Claude-Mem 通过 `CLAUDE_MEM_MODE` 设置支持多种工作流模式和语言。

此选项同时控制：
- 工作流行为（如 code、chill、investigation）
- 生成观察时使用的语言

#### 如何配置

编辑 `~/.claude-mem/settings.json` 设置文件：

```json
{
  "CLAUDE_MEM_MODE": "code--zh"
}
```

模式定义在 `plugin/modes/` 中。本地查看所有可用模式：

```bash
ls ~/.claude/plugins/marketplaces/thedotmack/plugin/modes/
```

#### 可用模式

| 模式 | 说明 |
|------------|-------------------------|
| `code` | 默认英语模式 |
| `code--zh` | 简体中文模式 |
| `code--ja` | 日语模式 |

语言特定模式遵循 `code--[lang]` 格式，其中 `[lang]` 为 ISO 639-1 语言代码（如 zh 表示中文，ja 表示日语，es 表示西班牙语）。

> 注意：`code--zh`（简体中文）已内置 — 无需额外安装或更新插件。

#### 更改模式后

重启 Claude Code 以应用新模式配置。
---

## 开发

详见 **[开发指南](https://docs.claude-mem.ai/development)** 了解构建说明、测试与贡献流程。

---

## 故障排除

如遇问题，向 Claude 描述问题，troubleshoot 技能将自动诊断并提供修复方案。

详见 **[故障排除指南](https://docs.claude-mem.ai/troubleshooting)** 了解常见问题与解决方案。

---

## Bug 报告

使用自动生成器创建完整的 bug 报告：

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## 贡献

欢迎贡献！请：

1. Fork 仓库
2. 创建功能分支
3. 进行更改并添加测试
4. 更新文档
5. 提交 Pull Request

详见[开发指南](https://docs.claude-mem.ai/development)了解贡献流程。

---

## 许可证

Claude-Mem 采用 Apache License 2.0 许可证。

我们选择 Apache-2.0，是因为持久的智能体内存应易于嵌入
开发者工具、本地智能体、MCP 服务器、企业系统、机器人栈
以及生产级智能体框架中。

详见 [LICENSE](LICENSE) 文件。另见 [docs/license.md](docs/license.md)
与 [docs/ip-boundary.md](docs/ip-boundary.md) 了解许可范围及
开源/商业边界。

**关于 Ragtime**：`ragtime/` 目录采用 **Apache License 2.0**。详见 [ragtime/LICENSE](ragtime/LICENSE)。

---

## 支持

- **文档**：[docs/](docs/)
- **问题**：[GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **仓库**：[github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **官方 X 账号**：[@Claude_Memory](https://x.com/Claude_Memory)
- **官方 Discord**：[加入 Discord](https://discord.com/invite/J4wttp9vDu)
- **作者**：Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**使用 Claude Agent SDK 构建** | **适用于 Claude Code** | **使用 TypeScript 制作**

---

### 关于 $CMEM

$CMEM 是由第三方在未经 Claude-Mem 事先同意的情况下创建的 Solana 代币，但已被 Claude-Mem 创建者 Alex Newman (@thedotmack) 官方接纳。该代币作为社区增长催化剂，并为最需要的开发者和知识工作者提供实时智能体数据的载体。$CMEM: 2TsmuYUrsctE57VLckZBYEEzdokUF8j8e1GavekWBAGS
