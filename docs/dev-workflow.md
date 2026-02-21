# Development Workflow: feature/titans-with-pipeline

## 日常開發循環

```
編輯 src/ → npm run dev:local → 測試
```

```bash
# 修改 src/ 後，build + 部署到 marketplace + 重啟 worker
npm run dev:local
```

## 常用指令速查

| 指令 | 用途 |
|------|------|
| `npm run dev:local` | build + deploy + restart worker（日常主命令）|
| `npm run build` | 只 build，不 deploy |
| `npm run worker:status` | 查看 worker 狀態 |
| `npm run worker:logs` | 今日 worker log |
| `npm run worker:tail` | 即時追蹤 worker log |
| `npm test` | 執行所有測試 |

## 主動與 main 同步

```bash
# 手動觸發（不等 cron）
bash scripts/auto-sync-main.sh

# 查看 sync log
tail -30 ~/.claude-mem/logs/auto-sync.log
```

cron 每天 03:00 自動執行，有衝突時會中止並記錄到 log，不留爛掉的 repo 狀態。

## 架構對應

```
src/                        ← 你修改這裡
  hooks/                    ← SessionStart / Stop / PostToolUse hooks
  services/worker-service.ts ← HTTP API、worker 主體
  services/worker/           ← domain services
  services/pipeline/         ← titans-with-pipeline 的核心 feature

plugin/scripts/              ← built artifacts（不要手動改）
  worker-service.cjs         ← src/ build 產物
  bun-runner.js              ← Node wrapper，傳 stdin 給 Bun

~/.claude/plugins/marketplaces/thedotmack/  ← 部署目標（不是 git repo）
  plugin/                   ← 由 deploy-local.sh rsync 過來
```

## Branch 策略

- `feature/titans-with-pipeline` ← 主要開發 branch（你在這）
- `main` ← upstream（只 merge 進來，不直接 push）
- `fork/feature/titans-with-pipeline` ← 你的 GitHub remote

```bash
# push 到你自己的 fork
git push fork feature/titans-with-pipeline
```

## 常見問題

**Worker crash / 沒反應**
```bash
npm run worker:logs     # 看 log
npm run worker:restart  # 重啟
```

**Merge conflict（cron 失敗）**
```bash
cd ~/Documents/GitHub/claude-mem
git status              # 確認狀態
git merge --abort       # 如果卡住
git merge main          # 手動 merge，解完衝突後
npm run dev:local       # 重新 build + deploy
```

**Marketplace 版本不符**
```bash
bash scripts/deploy-local.sh  # 重新同步
```
