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

<h4 align="center"><a href="https://claude.com/claude-code" target="_blank">Claude Code</a> 向け永続メモリ圧縮システム</h4>

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
</p>

<p align="center">
  <a href="#クイックスタート">クイックスタート</a> •
  <a href="#仕組み">仕組み</a> •
  <a href="#mem-searchスキル">検索ツール</a> •
  <a href="#設定">設定</a> •
  <a href="#トラブルシューティング">トラブルシューティング</a> •
  <a href="README.md">English</a>
</p>

<p align="center">
  Claude-Memは、ツール使用の観察を自動的にキャプチャし、セマンティックな要約を生成して将来のセッションで利用可能にすることで、セッション間でコンテキストをシームレスに保存します。これにより、セッションが終了または再接続した後でも、Claudeがプロジェクトに関する知識の継続性を維持できます。
</p>

---

## クイックスタート

ターミナルで新しいClaude Codeセッションを開始し、以下のコマンドを入力：

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Claude Codeを再起動。以前のセッションのコンテキストが自動的に新しいセッションに表示されます。

**主な機能：**

- 🧠 **永続メモリ** - セッション間でコンテキストを保持
- 📊 **段階的開示** - トークンコスト表示付きの階層型メモリ取得
- 🔍 **スキルベース検索** - mem-searchスキルでプロジェクト履歴を検索
- 🖥️ **Web Viewer UI** - http://localhost:37777 でリアルタイムメモリストリーム
- 💻 **Claude Desktopスキル** - Claude Desktopの会話からメモリを検索
- 🔒 **プライバシー制御** - `<private>`タグで機密コンテンツをストレージから除外
- ⚙️ **コンテキスト設定** - 注入されるコンテキストの細かい制御
- 🤖 **自動動作** - 手動操作は不要
- 🔗 **引用** - IDで過去の観察を参照（http://localhost:37777/api/observation/{id} でアクセス）

---

## 仕組み

```
┌─────────────────────────────────────────────────────────────┐
│ セッション開始 → 最近の観察をコンテキストとして注入           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ ユーザープロンプト → セッション作成、ユーザープロンプトを保存  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ ツール実行 → 観察をキャプチャ（Read, Write など）            │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ ワーカー処理 → Claude Agent SDK で学習内容を抽出             │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ セッション終了 → 要約を生成、次のセッションに備える           │
└─────────────────────────────────────────────────────────────┘
```

**コアコンポーネント：**

1. **5つのライフサイクルフック** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd
2. **スマートインストール** - キャッシュされた依存関係チェッカー
3. **ワーカーサービス** - ポート37777のHTTP API、Web Viewer UIと10の検索エンドポイント
4. **SQLiteデータベース** - セッション、観察、要約をFTS5全文検索で保存
5. **mem-searchスキル** - 段階的開示による自然言語クエリ
6. **Chromaベクターデータベース** - インテリジェントなコンテキスト取得のためのハイブリッド検索

---

## mem-searchスキル

Claude-Memは、過去の作業について質問すると自動的に呼び出されるmem-searchスキルを通じてインテリジェントな検索を提供します：

**使い方：**
- 自然に質問するだけ：「前のセッションで何をした？」「このバグは前に直した？」
- Claudeが自動的にmem-searchスキルを呼び出して関連するコンテキストを検索

**利用可能な検索操作：**

1. **観察検索** - 観察の全文検索
2. **セッション検索** - セッション要約の全文検索
3. **プロンプト検索** - 生のユーザーリクエストを検索
4. **コンセプト検索** - コンセプトタグで検索
5. **ファイル検索** - 特定のファイルを参照する観察を検索
6. **タイプ検索** - タイプで検索（decision, bugfix, feature など）
7. **最近のコンテキスト** - プロジェクトの最近のセッションコンテキストを取得
8. **タイムライン** - 特定の時点周辺のコンテキストの統合タイムライン
9. **クエリでタイムライン** - 観察を検索し、最良の一致周辺のタイムラインコンテキストを取得
10. **APIヘルプ** - 検索APIドキュメントを取得

**自然言語クエリの例：**

```
「前のセッションで直したバグは？」
「認証をどう実装した？」
「worker-service.tsにどんな変更をした？」
「このプロジェクトの最近の作業を見せて」
「Viewer UIを追加した時に何が起きてた？」
```

---

## 設定

設定は `~/.claude-mem/settings.json` で管理されます。初回実行時にデフォルト値で自動作成されます。

**利用可能な設定：**

| 設定 | デフォルト | 説明 |
|------|---------|------|
| `CLAUDE_MEM_MODEL` | `claude-sonnet-4-5` | 観察用AIモデル |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | ワーカーサービスのポート |
| `CLAUDE_MEM_WORKER_HOST` | `127.0.0.1` | ワーカーバインドアドレス（リモートアクセスには`0.0.0.0`） |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | データディレクトリの場所 |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | ログの詳細度（DEBUG, INFO, WARN, ERROR, SILENT） |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | SessionStart時に注入する観察の数 |

**設定ファイル形式：**

```json
{
  "CLAUDE_MEM_MODEL": "claude-sonnet-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

---

## システム要件

- **Node.js**: 18.0.0以上
- **Claude Code**: プラグインサポート付きの最新バージョン
- **Bun**: JavaScriptランタイムとプロセスマネージャー（存在しない場合は自動インストール）
- **uv**: ベクター検索用Pythonパッケージマネージャー（存在しない場合は自動インストール）
- **SQLite 3**: 永続ストレージ用（バンドル）

---

## トラブルシューティング

**クイック診断：**

問題が発生した場合、Claudeに問題を説明するとトラブルシューティングスキルが自動的に起動して診断と修正を提供します。

**よくある問題：**

- ワーカーが起動しない → `npm run worker:restart`
- コンテキストが表示されない → `npm run test:context`
- データベースの問題 → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- 検索が動作しない → FTS5テーブルの存在を確認

### Windowsの既知の問題

**コンソールウィンドウの表示**: Windowsでは、ワーカーサービスの起動時にコンソールウィンドウが一瞬表示されることがあります。これは外観上の問題で、将来のリリースで対処予定です。

---

## 開発

```bash
# クローンとビルド
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# テスト実行
npm test

# ワーカー起動
npm run worker:start

# ログ表示
npm run worker:logs
```

---

## ライセンス

このプロジェクトは **GNU Affero General Public License v3.0** (AGPL-3.0) の下でライセンスされています。

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

**意味すること：**

- このソフトウェアを自由に使用、修正、配布できます
- ネットワークサーバーで変更・展開する場合、ソースコードを公開する必要があります
- 派生作品もAGPL-3.0でライセンスする必要があります
- このソフトウェアには保証がありません

---

## サポート

- **ドキュメント**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **リポジトリ**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **作者**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Built with Claude Agent SDK** | **Powered by Claude Code** | **Made with TypeScript**
