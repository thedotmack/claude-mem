🌐 这是自动翻译。欢迎社区修正!

---
<h1 align="center">
  <br>
  <a href="https://github.com/doublefx/magic-claude-mem">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/doublefx/magic-claude-mem/main/docs/public/magic-claude-mem-logo-for-dark-mode.webp">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/doublefx/magic-claude-mem/main/docs/public/magic-claude-mem-logo-for-light-mode.webp">
      <img src="https://raw.githubusercontent.com/doublefx/magic-claude-mem/main/docs/public/magic-claude-mem-logo-for-light-mode.webp" alt="Magic-Claude-Mem" width="400">
    </picture>
  </a>
  <br>
</h1>

<p align="center">
  <a href="README.zh.md">🇨🇳 中文</a> •
  <a href="README.ja.md">🇯🇵 日本語</a> •
  <a href="README.pt-br.md">🇧🇷 Português</a> •
  <a href="README.ko.md">🇰🇷 한국어</a> •
  <a href="README.es.md">🇪🇸 Español</a> •
  <a href="README.de.md">🇩🇪 Deutsch</a> •
  <a href="README.fr.md">🇫🇷 Français</a>
  <a href="README.he.md">🇮🇱 עברית</a> •
  <a href="README.ar.md">🇸🇦 العربية</a> •
  <a href="README.ru.md">🇷🇺 Русский</a> •
  <a href="README.pl.md">🇵🇱 Polski</a> •
  <a href="README.cs.md">🇨🇿 Čeština</a> •
  <a href="README.nl.md">🇳🇱 Nederlands</a> •
  <a href="README.tr.md">🇹🇷 Türkçe</a> •
  <a href="README.uk.md">🇺🇦 Українська</a> •
  <a href="README.vi.md">🇻🇳 Tiếng Việt</a> •
  <a href="README.id.md">🇮🇩 Indonesia</a> •
  <a href="README.th.md">🇹🇭 ไทย</a> •
  <a href="README.hi.md">🇮🇳 हिन्दी</a> •
  <a href="README.bn.md">🇧🇩 বাংলা</a> •
  <a href="README.ro.md">🇷🇴 Română</a> •
  <a href="README.sv.md">🇸🇪 Svenska</a> •
  <a href="README.it.md">🇮🇹 Italiano</a> •
  <a href="README.el.md">🇬🇷 Ελληνικά</a> •
  <a href="README.hu.md">🇭🇺 Magyar</a> •
  <a href="README.fi.md">🇫🇮 Suomi</a> •
  <a href="README.da.md">🇩🇰 Dansk</a> •
  <a href="README.no.md">🇳🇴 Norsk</a>
</p>

<h4 align="center">为 <a href="https://claude.com/claude-code" target="_blank">Claude Code</a> 构建的持久化内存压缩系统。</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-AGPL%203.0-blue.svg" alt="License">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/version-6.5.0-green.svg" alt="Version">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg" alt="Node">
  </a>
  <a href="https://github.com/doublefx/awesome-claude-code">
    <img src="https://awesome.re/mentioned-badge.svg" alt="Mentioned in Awesome Claude Code">
  </a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/15496" target="_blank">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/doublefx/magic-claude-mem/main/docs/public/trendshift-badge-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/doublefx/magic-claude-mem/main/docs/public/trendshift-badge.svg">
      <img src="https://raw.githubusercontent.com/doublefx/magic-claude-mem/main/docs/public/trendshift-badge.svg" alt="doublefx/magic-claude-mem | Trendshift" width="250" height="55"/>
    </picture>
  </a>
</p>

<br>

<p align="center">
  <a href="https://github.com/doublefx/magic-claude-mem">
    <picture>
      <img src="https://raw.githubusercontent.com/doublefx/magic-claude-mem/main/docs/public/cm-preview.gif" alt="Magic-Claude-Mem Preview" width="800">
    </picture>
  </a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> •
  <a href="#工作原理">工作原理</a> •
  <a href="#mcp-搜索工具">搜索工具</a> •
  <a href="#文档">文档</a> •
  <a href="#配置">配置</a> •
  <a href="#故障排除">故障排除</a> •
  <a href="#许可证">许可证</a>
</p>

<p align="center">
  Magic-Claude-Mem 通过自动捕获工具使用观察、生成语义摘要并使其可用于未来会话,无缝保留跨会话的上下文。这使 Claude 能够在会话结束或重新连接后仍保持对项目的知识连续性。
</p>

---

## 快速开始

在终端中启动新的 Claude Code 会话并输入以下命令:

```
> /plugin marketplace add doublefx/magic-claude-mem

> /plugin install magic-claude-mem
```

重启 Claude Code。来自先前会话的上下文将自动出现在新会话中。

**核心特性:**

- 🧠 **持久化内存** - 上下文跨会话保留
- 📊 **渐进式披露** - 分层内存检索,具有令牌成本可见性
- 🔍 **基于技能的搜索** - 使用 mem-search 技能查询项目历史
- 🖥️ **Web 查看器界面** - 在 http://localhost:37777 实时查看内存流
- 💻 **Claude Desktop 技能** - 从 Claude Desktop 对话中搜索内存
- 🔒 **隐私控制** - 使用 `<private>` 标签排除敏感内容的存储
- ⚙️ **上下文配置** - 精细控制注入的上下文内容
- 🤖 **自动操作** - 无需手动干预
- 🔗 **引用** - 使用 ID 引用过去的观察(通过 http://localhost:37777/api/observation/{id} 访问,或在 http://localhost:37777 的 Web 查看器中查看全部)

---

## 文档

📚 **[查看完整文档](docs/)** - 在 GitHub 上浏览 Markdown 文档

### 入门指南

- **[安装指南](https://docs.magic-claude-mem.ai/installation)** - 快速开始与高级安装
- **[使用指南](https://docs.magic-claude-mem.ai/usage/getting-started)** - Magic-Claude-Mem 如何自动工作
- **[搜索工具](https://docs.magic-claude-mem.ai/usage/search-tools)** - 使用自然语言查询项目历史

### 最佳实践

- **[上下文工程](https://docs.magic-claude-mem.ai/context-engineering)** - AI 代理上下文优化原则
- **[渐进式披露](https://docs.magic-claude-mem.ai/progressive-disclosure)** - Magic-Claude-Mem 上下文启动策略背后的哲学

### 架构

- **[概述](https://docs.magic-claude-mem.ai/architecture/overview)** - 系统组件与数据流
- **[架构演进](https://docs.magic-claude-mem.ai/architecture-evolution)** - 从 v3 到 v5 的旅程
- **[钩子架构](https://docs.magic-claude-mem.ai/hooks-architecture)** - Magic-Claude-Mem 如何使用生命周期钩子
- **[钩子参考](https://docs.magic-claude-mem.ai/architecture/hooks)** - 7 个钩子脚本详解
- **[Worker 服务](https://docs.magic-claude-mem.ai/architecture/worker-service)** - HTTP API 与 Node.js 管理
- **[数据库](https://docs.magic-claude-mem.ai/architecture/database)** - SQLite 模式与 FTS5 搜索
- **[搜索架构](https://docs.magic-claude-mem.ai/architecture/search-architecture)** - 使用 Chroma 向量数据库的混合搜索

### 配置与开发

- **[配置](https://docs.magic-claude-mem.ai/configuration)** - 环境变量与设置
- **[开发](https://docs.magic-claude-mem.ai/development)** - 构建、测试、贡献
- **[故障排除](https://docs.magic-claude-mem.ai/troubleshooting)** - 常见问题与解决方案

---

## 工作原理

**核心组件:**

1. **5 个生命周期钩子** - SessionStart、UserPromptSubmit、PostToolUse、Stop、SessionEnd(6 个钩子脚本)
2. **智能安装** - 缓存依赖检查器(预钩子脚本,不是生命周期钩子)
3. **Worker 服务** - 在端口 37777 上的 HTTP API,带有 Web 查看器界面和 10 个搜索端点,由 Node.js 管理
4. **SQLite 数据库** - 存储会话、观察、摘要
5. **mem-search 技能** - 具有渐进式披露的自然语言查询
6. **Chroma 向量数据库** - 混合语义 + 关键词搜索,实现智能上下文检索

详见[架构概述](https://docs.magic-claude-mem.ai/architecture/overview)。

---

## mem-search 技能

Magic-Claude-Mem 通过 mem-search 技能提供智能搜索,当您询问过去的工作时会自动调用:

**工作方式:**
- 只需自然提问:*"上次会话我们做了什么?"* 或 *"我们之前修复过这个 bug 吗?"*
- Claude 自动调用 mem-search 技能查找相关上下文

**可用搜索操作:**

1. **搜索观察** - 跨观察的全文搜索
2. **搜索会话** - 跨会话摘要的全文搜索
3. **搜索提示** - 搜索原始用户请求
4. **按概念搜索** - 按概念标签查找(发现、问题-解决方案、模式等)
5. **按文件搜索** - 查找引用特定文件的观察
6. **按类型搜索** - 按类型查找(决策、bug修复、功能、重构、发现、更改)
7. **最近上下文** - 获取项目的最近会话上下文
8. **时间线** - 获取特定时间点周围的统一上下文时间线
9. **按查询的时间线** - 搜索观察并获取最佳匹配周围的时间线上下文
10. **API 帮助** - 获取搜索 API 文档

**自然语言查询示例:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

详见[搜索工具指南](https://docs.magic-claude-mem.ai/usage/search-tools)的详细示例。

---

## 系统要求

- **Node.js**: 18.0.0 或更高版本
- **Claude Code**: 支持插件的最新版本
- **uv**: 用于向量搜索的 Python 包管理器(如缺失会自动安装)
- **SQLite 3**: 用于持久化存储(已内置)

---

## 配置

设置在 `~/.magic-claude-mem/settings.json` 中管理(首次运行时自动创建默认设置)。可配置 AI 模型、worker 端口、数据目录、日志级别和上下文注入设置。

详见**[配置指南](https://docs.magic-claude-mem.ai/configuration)**了解所有可用设置和示例。

---

## 开发

详见**[开发指南](https://docs.magic-claude-mem.ai/development)**了解构建说明、测试和贡献工作流程。

---

## 故障排除

如果遇到问题,向 Claude 描述问题,troubleshoot 技能将自动诊断并提供修复方案。

详见**[故障排除指南](https://docs.magic-claude-mem.ai/troubleshooting)**了解常见问题和解决方案。

---

## Bug 报告

使用自动生成器创建全面的 bug 报告:

```bash
cd ~/.claude/plugins/marketplaces/doublefx
npm run bug-report
```

## 贡献

欢迎贡献!请:

1. Fork 仓库
2. 创建功能分支
3. 进行更改并添加测试
4. 更新文档
5. 提交 Pull Request

详见[开发指南](https://docs.magic-claude-mem.ai/development)了解贡献工作流程。

---

## 许可证

本项目采用 **GNU Affero General Public License v3.0** (AGPL-3.0) 许可。

Copyright (C) 2026 Frederic Thomas (@doublefx)。保留所有权利。

详见 [LICENSE](LICENSE) 文件了解完整详情。

**这意味着什么:**

- 您可以自由使用、修改和分发本软件
- 如果您修改并部署到网络服务器上,必须公开您的源代码
- 衍生作品也必须采用 AGPL-3.0 许可
- 本软件不提供任何保证

---

## 支持

- **文档**: [docs/](docs/)
- **问题反馈**: [GitHub Issues](https://github.com/doublefx/magic-claude-mem/issues)
- **仓库**: [github.com/doublefx/magic-claude-mem](https://github.com/doublefx/magic-claude-mem)
- **作者**: Frederic Thomas ([@doublefx](https://github.com/doublefx))

---

**使用 Claude Agent SDK 构建** | **由 Claude Code 驱动** | **使用 TypeScript 制作**

---