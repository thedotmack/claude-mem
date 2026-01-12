🌐 これは自動翻訳です。コミュニティによる修正を歓迎します!

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
  <a href="README.ur.md">🇵🇰 اردو</a> •
  <a href="README.ro.md">🇷🇴 Română</a> •
  <a href="README.sv.md">🇸🇪 Svenska</a> •
  <a href="README.it.md">🇮🇹 Italiano</a> •
  <a href="README.el.md">🇬🇷 Ελληνικά</a> •
  <a href="README.hu.md">🇭🇺 Magyar</a> •
  <a href="README.fi.md">🇫🇮 Suomi</a> •
  <a href="README.da.md">🇩🇰 Dansk</a> •
  <a href="README.no.md">🇳🇴 Norsk</a>
</p>

<h4 align="center"><a href="https://claude.com/claude-code" target="_blank">Claude Code</a>向けに構築された永続的メモリ圧縮システム</h4>

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
  <a href="#クイックスタート">クイックスタート</a> •
  <a href="#仕組み">仕組み</a> •
  <a href="#mcp検索ツール">検索ツール</a> •
  <a href="#ドキュメント">ドキュメント</a> •
  <a href="#設定">設定</a> •
  <a href="#トラブルシューティング">トラブルシューティング</a> •
  <a href="#ライセンス">ライセンス</a>
</p>

<p align="center">
  Claude-Memは、ツール使用の観察を自動的にキャプチャし、セマンティックサマリーを生成して将来のセッションで利用可能にすることで、セッション間のコンテキストをシームレスに保持します。これにより、Claudeはセッションが終了または再接続された後でも、プロジェクトに関する知識の連続性を維持できます。
</p>

---

## クイックスタート

ターミナルで新しいClaude Codeセッションを開始し、次のコマンドを入力します:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Claude Codeを再起動します。以前のセッションからのコンテキストが新しいセッションに自動的に表示されます。

**主な機能:**

- 🧠 **永続的メモリ** - セッション間でコンテキストが保持される
- 📊 **プログレッシブディスクロージャー** - トークンコストの可視性を持つ階層的メモリ取得
- 🔍 **スキルベース検索** - mem-searchスキルでプロジェクト履歴をクエリ
- 🖥️ **Webビューア UI** - http://localhost:37777 でリアルタイムメモリストリームを表示
- 💻 **Claude Desktopスキル** - Claude Desktopの会話からメモリを検索
- 🔒 **プライバシー制御** - `<private>`タグを使用して機密コンテンツをストレージから除外
- ⚙️ **コンテキスト設定** - どのコンテキストが注入されるかを細かく制御
- 🤖 **自動動作** - 手動介入不要
- 🔗 **引用** - IDで過去の観察を参照(http://localhost:37777/api/observation/{id} でアクセス、またはhttp://localhost:37777 のWebビューアですべて表示)
- 🧪 **ベータチャネル** - バージョン切り替えでEndless Modeなどの実験的機能を試す

---

## ドキュメント

📚 **[完全なドキュメントを見る](https://docs.claude-mem.ai/)** - 公式ウェブサイトで閲覧

### はじめに

- **[インストールガイド](https://docs.claude-mem.ai/installation)** - クイックスタートと高度なインストール
- **[使用ガイド](https://docs.claude-mem.ai/usage/getting-started)** - Claude-Memが自動的に動作する仕組み
- **[検索ツール](https://docs.claude-mem.ai/usage/search-tools)** - 自然言語でプロジェクト履歴をクエリ
- **[ベータ機能](https://docs.claude-mem.ai/beta-features)** - Endless Modeなどの実験的機能を試す

### ベストプラクティス

- **[コンテキストエンジニアリング](https://docs.claude-mem.ai/context-engineering)** - AIエージェントのコンテキスト最適化原則
- **[プログレッシブディスクロージャー](https://docs.claude-mem.ai/progressive-disclosure)** - Claude-Memのコンテキストプライミング戦略の背後にある哲学

### アーキテクチャ

- **[概要](https://docs.claude-mem.ai/architecture/overview)** - システムコンポーネントとデータフロー
- **[アーキテクチャの進化](https://docs.claude-mem.ai/architecture-evolution)** - v3からv5への道のり
- **[フックアーキテクチャ](https://docs.claude-mem.ai/hooks-architecture)** - Claude-Memがライフサイクルフックを使用する方法
- **[フックリファレンス](https://docs.claude-mem.ai/architecture/hooks)** - 7つのフックスクリプトの説明
- **[ワーカーサービス](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP APIとBun管理
- **[データベース](https://docs.claude-mem.ai/architecture/database)** - SQLiteスキーマとFTS5検索
- **[検索アーキテクチャ](https://docs.claude-mem.ai/architecture/search-architecture)** - Chromaベクトルデータベースを使用したハイブリッド検索

### 設定と開発

- **[設定](https://docs.claude-mem.ai/configuration)** - 環境変数と設定
- **[開発](https://docs.claude-mem.ai/development)** - ビルド、テスト、コントリビューション
- **[トラブルシューティング](https://docs.claude-mem.ai/troubleshooting)** - よくある問題と解決策

---

## 仕組み

**コアコンポーネント:**

1. **5つのライフサイクルフック** - SessionStart、UserPromptSubmit、PostToolUse、Stop、SessionEnd(6つのフックスクリプト)
2. **スマートインストール** - キャッシュされた依存関係チェッカー(プレフックスクリプト、ライフサイクルフックではない)
3. **ワーカーサービス** - ポート37777上のHTTP API、WebビューアUIと10の検索エンドポイント、Bunで管理
4. **SQLiteデータベース** - セッション、観察、サマリーを保存
5. **mem-searchスキル** - プログレッシブディスクロージャーを備えた自然言語クエリ
6. **Chromaベクトルデータベース** - インテリジェントなコンテキスト取得のためのハイブリッドセマンティック+キーワード検索

詳細は[アーキテクチャ概要](https://docs.claude-mem.ai/architecture/overview)を参照してください。

---

## mem-searchスキル

Claude-Memは、過去の作業について尋ねると自動的に呼び出されるmem-searchスキルを通じてインテリジェント検索を提供します:

**仕組み:**
- 自然に質問するだけ: *「前回のセッションで何をしましたか?」* または *「以前このバグを修正しましたか?」*
- Claudeは自動的にmem-searchスキルを呼び出して関連するコンテキストを検索します

**利用可能な検索操作:**

1. **観察の検索** - 観察全体にわたる全文検索
2. **セッションの検索** - セッションサマリー全体にわたる全文検索
3. **プロンプトの検索** - 生のユーザーリクエストを検索
4. **コンセプト別** - コンセプトタグで検索(discovery、problem-solution、patternなど)
5. **ファイル別** - 特定のファイルを参照している観察を検索
6. **タイプ別** - タイプ別に検索(decision、bugfix、feature、refactor、discovery、change)
7. **最近のコンテキスト** - プロジェクトの最近のセッションコンテキストを取得
8. **タイムライン** - 特定の時点周辺のコンテキストの統一タイムラインを取得
9. **クエリ別タイムライン** - 観察を検索し、最適な一致周辺のタイムラインコンテキストを取得
10. **APIヘルプ** - 検索APIドキュメントを取得

**自然言語クエリの例:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

詳細な例は[検索ツールガイド](https://docs.claude-mem.ai/usage/search-tools)を参照してください。

---

## ベータ機能

Claude-Memは、**Endless Mode**(拡張セッション用の生体模倣メモリアーキテクチャ)などの実験的機能を備えた**ベータチャネル**を提供します。http://localhost:37777 → SettingsのWebビューアUIから安定版とベータ版を切り替えます。

Endless Modeと試用方法の詳細については、**[ベータ機能ドキュメント](https://docs.claude-mem.ai/beta-features)** を参照してください。

---

## システム要件

- **Node.js**: 18.0.0以上
- **Claude Code**: プラグインサポートを備えた最新バージョン
- **Bun**: JavaScriptランタイムおよびプロセスマネージャー(不足している場合は自動インストール)
- **uv**: ベクトル検索用のPythonパッケージマネージャー(不足している場合は自動インストール)
- **SQLite 3**: 永続ストレージ用(バンドル済み)

---

## 設定

設定は`~/.claude-mem/settings.json`で管理されます(初回実行時にデフォルト値で自動作成)。AIモデル、ワーカーポート、データディレクトリ、ログレベル、コンテキスト注入設定を構成します。

利用可能なすべての設定と例については、**[設定ガイド](https://docs.claude-mem.ai/configuration)** を参照してください。

---

## 開発

ビルド手順、テスト、コントリビューションワークフローについては、**[開発ガイド](https://docs.claude-mem.ai/development)** を参照してください。

---

## トラブルシューティング

問題が発生した場合は、Claudeに問題を説明すると、troubleshootスキルが自動的に診断して修正を提供します。

よくある問題と解決策については、**[トラブルシューティングガイド](https://docs.claude-mem.ai/troubleshooting)** を参照してください。

---

## バグレポート

自動ジェネレーターで包括的なバグレポートを作成します:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## コントリビューション

コントリビューションを歓迎します! 以下の手順に従ってください:

1. リポジトリをフォーク
2. 機能ブランチを作成
3. テストと共に変更を加える
4. ドキュメントを更新
5. プルリクエストを提出

コントリビューションワークフローについては[開発ガイド](https://docs.claude-mem.ai/development)を参照してください。

---

## ライセンス

このプロジェクトは**GNU Affero General Public License v3.0**(AGPL-3.0)の下でライセンスされています。

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

詳細は[LICENSE](LICENSE)ファイルを参照してください。

**これが意味すること:**

- このソフトウェアを自由に使用、変更、配布できます
- ネットワークサーバーで変更して展開する場合、ソースコードを利用可能にする必要があります
- 派生作品もAGPL-3.0の下でライセンスする必要があります
- このソフトウェアには保証がありません

**Ragtimeに関する注意**: `ragtime/`ディレクトリは **PolyForm Noncommercial License 1.0.0** の下で個別にライセンスされています。詳細は[ragtime/LICENSE](ragtime/LICENSE)を参照してください。

---

## サポート

- **ドキュメント**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **リポジトリ**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **作者**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Claude Agent SDKで構築** | **Claude Codeで動作** | **TypeScriptで作成**
