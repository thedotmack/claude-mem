🌐 这是自动翻译的内容。欢迎社区修正!

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
  <a href="https://github.com/thedotmack/awesome-claude-code">
    <img src="https://awesome.re/mentioned-badge.svg" alt="Mentioned in Awesome Claude Code">
  </a>
</p>

<br>

<p align="center">
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/cm-preview.gif" alt="Claude-Mem Preview" width="800">
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
  Claude-Mem 通过自动捕获工具使用观察、生成语义摘要并使其在未来会话中可用,从而无缝保留跨会话的上下文。这使 Claude 能够在会话结束或重新连接后仍保持对项目知识的连续性。
</p>

---

## 快速开始

在终端中启动一个新的 Claude Code 会话并输入以下命令:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

重启 Claude Code。先前会话的上下文将自动出现在新会话中。

**核心功能:**

- 🧠 **持久化内存** - 上下文在会话之间保持
- 📊 **渐进式披露** - 分层内存检索,具有令牌成本可见性
- 🔍 **基于技能的搜索** - 使用 mem-search 技能查询项目历史(节省约 2,250 个令牌)
- 🖥️ **Web 查看器界面** - http://localhost:37777 上的实时内存流
- 🔒 **隐私控制** - 使用 `<private>` 标签排除敏感内容的存储
- ⚙️ **上下文配置** - 细粒度控制注入的上下文内容
- 🤖 **自动操作** - 无需手动干预
- 🔗 **引用** - 使用 `claude-mem://` URI 引用过去的决策
- 🧪 **Beta 频道** - 通过版本切换尝试 Endless Mode 等实验性功能

---

## 文档

📚 **[查看完整文档](docs/)** - 在 GitHub 上浏览 markdown 文档

💻 **本地预览**: 在本地运行 Mintlify 文档:

```bash
cd docs
npx mintlify dev
```

### 入门指南

- **[安装指南](https://docs.claude-mem.ai/installation)** - 快速开始与高级安装
- **[使用指南](https://docs.claude-mem.ai/usage/getting-started)** - Claude-Mem 如何自动工作
- **[搜索工具](https://docs.claude-mem.ai/usage/search-tools)** - 使用自然语言查询项目历史
- **[Beta 功能](https://docs.claude-mem.ai/beta-features)** - 尝试 Endless Mode 等实验性功能

### 最佳实践

- **[上下文工程](https://docs.claude-mem.ai/context-engineering)** - AI 代理上下文优化原则
- **[渐进式披露](https://docs.claude-mem.ai/progressive-disclosure)** - Claude-Mem 上下文预处理策略背后的理念

### 架构

- **[概述](https://docs.claude-mem.ai/architecture/overview)** - 系统组件与数据流
- **[架构演进](https://docs.claude-mem.ai/architecture-evolution)** - 从 v3 到 v5 的历程
- **[钩子架构](https://docs.claude-mem.ai/hooks-architecture)** - Claude-Mem 如何使用生命周期钩子
- **[钩子参考](https://docs.claude-mem.ai/architecture/hooks)** - 7 个钩子脚本说明
- **[Worker 服务](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API 与 PM2 管理
- **[数据库](https://docs.claude-mem.ai/architecture/database)** - SQLite 架构与 FTS5 搜索
- **[搜索架构](https://docs.claude-mem.ai/architecture/search-architecture)** - 使用 Chroma 向量数据库的混合搜索

### 配置与开发

- **[配置](https://docs.claude-mem.ai/configuration)** - 环境变量与设置
- **[开发](https://docs.claude-mem.ai/development)** - 构建、测试、贡献
- **[故障排除](https://docs.claude-mem.ai/troubleshooting)** - 常见问题与解决方案

---

## 工作原理

```
┌─────────────────────────────────────────────────────────────┐
│ 会话开始 → 将最近的观察作为上下文注入                        │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 用户提示 → 创建会话,保存用户提示                             │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 工具执行 → 捕获观察(Read、Write 等)                          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Worker 处理 → 通过 Claude Agent SDK 提取学习内容             │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 会话结束 → 生成摘要,为下一会话做好准备                        │
└─────────────────────────────────────────────────────────────┘
```

**核心组件:**

1. **5 个生命周期钩子** - SessionStart、UserPromptSubmit、PostToolUse、Stop、SessionEnd(6 个钩子脚本)
2. **智能安装** - 缓存依赖项检查器(预钩子脚本,不是生命周期钩子)
3. **Worker 服务** - 端口 37777 上的 HTTP API,带有 web 查看器界面和 10 个搜索端点,由 PM2 管理
4. **SQLite 数据库** - 存储会话、观察、摘要,具有 FTS5 全文搜索
5. **mem-search 技能** - 使用渐进式披露的自然语言查询(相比 MCP 节省约 2,250 个令牌)
6. **Chroma 向量数据库** - 混合语义 + 关键词搜索,实现智能上下文检索

详情请参阅[架构概述](https://docs.claude-mem.ai/architecture/overview)。

---

## mem-search 技能

Claude-Mem 通过 mem-search 技能提供智能搜索,当您询问过去的工作时会自动调用:

**工作原理:**
- 只需自然提问: *"上一个会话我们做了什么?"* 或 *"我们之前修复过这个 bug 吗?"*
- Claude 自动调用 mem-search 技能查找相关上下文
- 相比 MCP 方法,每次会话开始节省约 2,250 个令牌

**可用搜索操作:**

1. **搜索观察** - 跨观察的全文搜索
2. **搜索会话** - 跨会话摘要的全文搜索
3. **搜索提示** - 搜索原始用户请求
4. **按概念搜索** - 按概念标签查找(discovery、problem-solution、pattern 等)
5. **按文件搜索** - 查找引用特定文件的观察
6. **按类型搜索** - 按类型查找(decision、bugfix、feature、refactor、discovery、change)
7. **最近上下文** - 获取项目的最近会话上下文
8. **时间线** - 获取特定时间点周围的统一上下文时间线
9. **按查询时间线** - 搜索观察并获取最佳匹配周围的时间线上下文
10. **API 帮助** - 获取搜索 API 文档

**自然语言查询示例:**

```
"上一个会话我们修复了哪些 bug?"
"我们如何实现身份验证的?"
"对 worker-service.ts 做了哪些更改?"
"显示这个项目的最近工作"
"添加查看器界面时发生了什么?"
```

详细示例请参阅[搜索工具指南](https://docs.claude-mem.ai/usage/search-tools)。

---

## Beta 功能与 Endless Mode

Claude-Mem 提供带有实验性功能的 **beta 频道**。可直接从 web 查看器界面在稳定版和 beta 版之间切换。

### 如何尝试 Beta

1. 打开 http://localhost:37777
2. 点击设置(齿轮图标)
3. 在 **Version Channel** 中,点击 "Try Beta (Endless Mode)"
4. 等待 worker 重启

切换版本时,您的内存数据会被保留。

### Endless Mode (Beta)

旗舰级 beta 功能是 **Endless Mode** - 一种仿生内存架构,可显著延长会话长度:

**问题**: 标准 Claude Code 会话在约 50 次工具使用后会达到上下文限制。每个工具添加 1-10k+ 令牌,而 Claude 在每次响应时都会重新合成所有先前的输出(O(N²) 复杂度)。

**解决方案**: Endless Mode 将工具输出压缩为约 500 令牌的观察,并实时转换转录:

```
工作内存(上下文):     压缩的观察(每个约 500 令牌)
归档内存(磁盘):       保留完整工具输出以供调用
```

**预期结果**:
- 上下文窗口中约 95% 的令牌减少
- 在上下文耗尽前约 20 倍的工具使用次数
- 线性 O(N) 扩展而非二次 O(N²)
- 保留完整转录以实现完美回忆

**注意事项**: 增加延迟(每个工具的观察生成需要 60-90 秒),仍处于实验阶段。

详情请参阅 [Beta 功能文档](https://docs.claude-mem.ai/beta-features)。

---

## 更新内容

**v6.4.9 - 上下文配置设置:**
- 11 个新设置,用于细粒度控制上下文注入
- 配置令牌经济学显示、按类型/概念过滤观察
- 控制观察数量和要显示的字段

**v6.4.0 - 双标签隐私系统:**
- `<private>` 标签用于用户控制的隐私 - 包裹敏感内容以排除存储
- 系统级 `<claude-mem-context>` 标签防止递归观察存储
- 边缘处理确保私有内容永远不会到达数据库

**v6.3.0 - 版本频道:**
- 从 web 查看器界面在稳定版和 beta 版之间切换
- 无需手动 git 操作即可尝试 Endless Mode 等实验性功能

**以前的亮点:**
- **v6.0.0**: 重大会话管理与转录处理改进
- **v5.5.0**: mem-search 技能增强,有效率达到 100%
- **v5.4.0**: 基于技能的搜索架构(每次会话节省约 2,250 令牌)
- **v5.1.0**: 基于 Web 的查看器界面,具有实时更新
- **v5.0.0**: 使用 Chroma 向量数据库的混合搜索

完整版本历史请参阅 [CHANGELOG.md](CHANGELOG.md)。

---

## 系统要求

- **Node.js**: 18.0.0 或更高版本
- **Claude Code**: 支持插件的最新版本
- **PM2**: 进程管理器(已捆绑 - 无需全局安装)
- **SQLite 3**: 用于持久化存储(已捆绑)

---

## 核心优势

### 渐进式披露上下文

- **分层内存检索**镜像人类记忆模式
- **第 1 层(索引)**: 在会话开始时查看存在哪些观察及其令牌成本
- **第 2 层(详情)**: 通过 MCP 搜索按需获取完整叙述
- **第 3 层(完美回忆)**: 访问源代码和原始转录
- **智能决策**: 令牌计数帮助 Claude 在获取详情或读取代码之间做出选择
- **类型指示器**: 视觉提示(🔴 关键、🟤 决策、🔵 信息性)突出显示观察的重要性

### 自动内存

- 当 Claude 启动时自动注入上下文
- 无需手动命令或配置
- 在后台透明工作

### 完整历史搜索

- 跨所有会话和观察搜索
- FTS5 全文搜索实现快速查询
- 引用链接回特定观察

### 结构化观察

- AI 驱动的学习内容提取
- 按类型分类(decision、bugfix、feature 等)
- 标记概念和文件引用

### 多提示会话

- 会话跨越多个用户提示
- 上下文在 `/clear` 命令之间保留
- 跟踪整个对话线程

---

## 配置

设置在 `~/.claude-mem/settings.json` 中管理。该文件在首次运行时使用默认值自动创建。

**可用设置:**

| 设置 | 默认值 | 描述 |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | 用于观察的 AI 模型 |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | Worker 服务端口 |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | 数据目录位置 |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | 日志详细程度(DEBUG、INFO、WARN、ERROR、SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | chroma-mcp 的 Python 版本 |
| `CLAUDE_CODE_PATH` | _(自动检测)_ | Claude 可执行文件路径 |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | SessionStart 时注入的观察数量 |

**设置管理:**

```bash
# 通过 CLI 帮助器编辑设置
./claude-mem-settings.sh

# 或直接编辑
nano ~/.claude-mem/settings.json

# 查看当前设置
curl http://localhost:37777/api/settings
```

**设置文件格式:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

详情请参阅[配置指南](https://docs.claude-mem.ai/configuration)。

---

## 开发

```bash
# 克隆并构建
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# 运行测试
npm test

# 启动 worker
npm run worker:start

# 查看日志
npm run worker:logs
```

详细说明请参阅[开发指南](https://docs.claude-mem.ai/development)。

---

## 故障排除

**快速诊断:**

如果您遇到问题,向 Claude 描述问题,troubleshoot 技能将自动激活以诊断并提供修复方案。

**常见问题:**

- Worker 未启动 → `npm run worker:restart`
- 没有上下文出现 → `npm run test:context`
- 数据库问题 → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- 搜索不工作 → 检查 FTS5 表是否存在

完整解决方案请参阅[故障排除指南](https://docs.claude-mem.ai/troubleshooting)。

---

## 贡献

欢迎贡献!请:

1. Fork 仓库
2. 创建功能分支
3. 进行更改并添加测试
4. 更新文档
5. 提交 Pull Request

贡献工作流程请参阅[开发指南](https://docs.claude-mem.ai/development)。

---

## 许可证

本项目根据 **GNU Affero General Public License v3.0** (AGPL-3.0) 授权。

Copyright (C) 2025 Alex Newman (@thedotmack). 保留所有权利。

完整详情请参阅 [LICENSE](LICENSE) 文件。

**这意味着什么:**

- 您可以自由使用、修改和分发此软件
- 如果您在网络服务器上修改并部署,您必须提供源代码
- 衍生作品也必须根据 AGPL-3.0 授权
- 本软件不提供任何保证

---

## 支持

- **文档**: [docs/](docs/)
- **问题**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **仓库**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **作者**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**使用 Claude Agent SDK 构建** | **由 Claude Code 驱动** | **使用 TypeScript 制作**