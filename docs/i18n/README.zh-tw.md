🌐 這是自動翻譯。歡迎社群貢獻修正！

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

<p align="center">
  <a href="README.zh.md">🇨🇳 中文</a> •
  <a href="README.zh-tw.md">🇹🇼 繁體中文</a> •
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

<h4 align="center">為 <a href="https://claude.com/claude-code" target="_blank">Claude Code</a> 打造的持久記憶壓縮系統</h4>

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

<p align="center">
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/cm-preview.gif" alt="Claude-Mem Preview" width="800">
    </picture>
  </a>
</p>

<p align="center">
  <a href="#快速開始">快速開始</a> •
  <a href="#運作原理">運作原理</a> •
  <a href="#mcp-搜尋工具">搜尋工具</a> •
  <a href="#文件">文件</a> •
  <a href="#設定">設定</a> •
  <a href="#疑難排解">疑難排解</a> •
  <a href="#授權條款">授權條款</a>
</p>

<p align="center">
  Claude-Mem 透過自動擷取工具使用觀察、產生語意摘要並在未來的工作階段中提供使用，無縫保留跨工作階段的脈絡。這使 Claude 即使在工作階段結束或重新連線後，仍能維持對專案的知識連續性。
</p>

---

## 快速開始

在終端機中開啟新的 Claude Code 工作階段，並輸入以下指令：

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

重新啟動 Claude Code。先前工作階段的脈絡將自動出現在新的工作階段中。

**主要功能：**

- 🧠 **持久記憶** - 脈絡跨工作階段保留
- 📊 **漸進式揭露** - 具有 Token 成本可見性的分層記憶擷取
- 🔍 **技能式搜尋** - 使用 mem-search 技能查詢專案歷史
- 🖥️ **網頁檢視介面** - 在 http://localhost:37777 即時檢視記憶串流
- 💻 **Claude Desktop 技能** - 從 Claude Desktop 對話中搜尋記憶
- 🔒 **隱私控制** - 使用 `<private>` 標籤排除敏感內容的儲存
- ⚙️ **脈絡設定** - 精細控制注入哪些脈絡
- 🤖 **自動運作** - 無需手動介入
- 🔗 **引用** - 使用 ID 參考過去的觀察（透過 http://localhost:37777/api/observation/{id} 存取，或在 http://localhost:37777 的網頁檢視器中檢視全部）
- 🧪 **Beta 通道** - 透過版本切換試用 Endless Mode 等實驗性功能

---

## 文件

📚 **[檢視完整文件](docs/)** - 在 GitHub 上瀏覽 Markdown 文件

### 入門指南

- **[安裝指南](https://docs.claude-mem.ai/installation)** - 快速開始與進階安裝
- **[使用指南](https://docs.claude-mem.ai/usage/getting-started)** - Claude-Mem 如何自動運作
- **[搜尋工具](https://docs.claude-mem.ai/usage/search-tools)** - 使用自然語言查詢專案歷史
- **[Beta 功能](https://docs.claude-mem.ai/beta-features)** - 試用 Endless Mode 等實驗性功能

### 最佳實務

- **[脈絡工程](https://docs.claude-mem.ai/context-engineering)** - AI 代理脈絡最佳化原則
- **[漸進式揭露](https://docs.claude-mem.ai/progressive-disclosure)** - Claude-Mem 脈絡啟動策略背後的理念

### 架構

- **[概覽](https://docs.claude-mem.ai/architecture/overview)** - 系統元件與資料流程
- **[架構演進](https://docs.claude-mem.ai/architecture-evolution)** - 從 v3 到 v5 的旅程
- **[Hooks 架構](https://docs.claude-mem.ai/hooks-architecture)** - Claude-Mem 如何使用生命週期掛鉤
- **[Hooks 參考](https://docs.claude-mem.ai/architecture/hooks)** - 7 個掛鉤腳本說明
- **[Worker 服務](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API 與 Bun 管理
- **[資料庫](https://docs.claude-mem.ai/architecture/database)** - SQLite 結構描述與 FTS5 搜尋
- **[搜尋架構](https://docs.claude-mem.ai/architecture/search-architecture)** - 使用 Chroma 向量資料庫的混合搜尋

### 設定與開發

- **[設定](https://docs.claude-mem.ai/configuration)** - 環境變數與設定
- **[開發](https://docs.claude-mem.ai/development)** - 建置、測試、貢獻
- **[疑難排解](https://docs.claude-mem.ai/troubleshooting)** - 常見問題與解決方案

---

## 運作原理

**核心元件：**

1. **5 個生命週期掛鉤** - SessionStart、UserPromptSubmit、PostToolUse、Stop、SessionEnd（6 個掛鉤腳本）
2. **智慧安裝** - 快取的相依性檢查器（pre-hook 腳本，非生命週期掛鉤）
3. **Worker 服務** - 連接埠 37777 上的 HTTP API，含網頁檢視介面與 10 個搜尋端點，由 Bun 管理
4. **SQLite 資料庫** - 儲存工作階段、觀察、摘要
5. **mem-search 技能** - 具有漸進式揭露的自然語言查詢
6. **Chroma 向量資料庫** - 用於智慧脈絡擷取的混合語意 + 關鍵字搜尋

詳情請參閱[架構概覽](https://docs.claude-mem.ai/architecture/overview)。

---

## MCP 搜尋工具

Claude-Mem 透過遵循 Token 高效的 **3 層工作流程模式**，以 **4 個 MCP 工具**提供智慧記憶搜尋：

**3 層工作流程：**

1. **`search`** - 取得精簡索引與 ID（每筆結果約 50-100 tokens）
2. **`timeline`** - 取得有趣結果周圍的時間脈絡
3. **`get_observations`** - 僅為過濾後的 ID 擷取完整詳情（每筆結果約 500-1,000 tokens）

**運作方式：**

- Claude 使用 MCP 工具搜尋您的記憶
- 從 `search` 開始取得結果索引
- 使用 `timeline` 檢視特定觀察周圍發生的事情
- 使用 `get_observations` 擷取相關 ID 的完整詳情
- 透過在擷取詳情前過濾，**節省約 10 倍 token**

**可用的 MCP 工具：**

1. **`search`** - 使用全文查詢搜尋記憶索引，依類型/日期/專案過濾
2. **`timeline`** - 取得特定觀察或查詢周圍的時間脈絡
3. **`get_observations`** - 依 ID 擷取完整觀察詳情（批次處理多個 ID）
4. **`__IMPORTANT`** - 工作流程文件（Claude 永遠可見）

**使用範例：**

```typescript
// 步驟 1：搜尋索引
search(query="authentication bug", type="bugfix", limit=10)

// 步驟 2：檢閱索引，識別相關 ID（例如 #123、#456）

// 步驟 3：擷取完整詳情
get_observations(ids=[123, 456])
```

詳細範例請參閱[搜尋工具指南](https://docs.claude-mem.ai/usage/search-tools)。

---

## Beta 功能

Claude-Mem 提供具有實驗性功能的 **Beta 通道**，例如 **Endless Mode**（用於延長工作階段的仿生記憶架構）。在 http://localhost:37777 → Settings 的網頁檢視介面中切換穩定版與 Beta 版。

有關 Endless Mode 與如何試用的詳情，請參閱 **[Beta 功能文件](https://docs.claude-mem.ai/beta-features)**。

---

## 系統需求

- **Node.js**：18.0.0 或更高版本
- **Claude Code**：具有外掛支援的最新版本
- **Bun**：JavaScript 執行環境與程序管理員（如缺少將自動安裝）
- **uv**：用於向量搜尋的 Python 套件管理員（如缺少將自動安裝）
- **SQLite 3**：用於持久儲存（已內建）

---

## 設定

設定在 `~/.claude-mem/settings.json` 中管理（首次執行時自動以預設值建立）。設定 AI 模型、Worker 連接埠、資料目錄、日誌層級與脈絡注入設定。

所有可用設定與範例請參閱 **[設定指南](https://docs.claude-mem.ai/configuration)**。

---

## 開發

建置說明、測試與貢獻工作流程請參閱 **[開發指南](https://docs.claude-mem.ai/development)**。

---

## 疑難排解

如遇問題，向 Claude 描述問題，troubleshoot 技能將自動診斷並提供修正。

常見問題與解決方案請參閱 **[疑難排解指南](https://docs.claude-mem.ai/troubleshooting)**。

---

## 錯誤回報

使用自動產生器建立完整的錯誤回報：

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## 貢獻

歡迎貢獻！請依照以下步驟：

1. Fork 儲存庫
2. 建立功能分支
3. 加入測試並進行變更
4. 更新文件
5. 提交 Pull Request

貢獻工作流程請參閱[開發指南](https://docs.claude-mem.ai/development)。

---

## 授權條款

本專案採用 **GNU Affero 通用公共授權條款 v3.0**（AGPL-3.0）授權。

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

完整詳情請參閱 [LICENSE](LICENSE) 檔案。

**這代表什麼：**

- 您可以自由使用、修改與散佈此軟體
- 如果您修改並部署於網路伺服器上，您必須公開您的原始碼
- 衍生作品也必須採用 AGPL-3.0 授權
- 本軟體不提供任何擔保

**關於 Ragtime 的說明**：`ragtime/` 目錄採用 **PolyForm Noncommercial License 1.0.0** 另行授權。詳情請參閱 [ragtime/LICENSE](ragtime/LICENSE)。

---

## 支援

- **文件**：[docs/](docs/)
- **Issues**：[GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **儲存庫**：[github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **官方 X 帳號**：[@Claude_Memory](https://x.com/Claude_Memory)
- **官方 Discord**：[加入 Discord](https://discord.com/invite/J4wttp9vDu)
- **作者**：Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**使用 Claude Agent SDK 建置** | **由 Claude Code 驅動** | **以 TypeScript 開發**
