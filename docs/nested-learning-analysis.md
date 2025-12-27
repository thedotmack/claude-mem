# Nested Learning 與 Sleep Agent 關聯分析

> 建立日期：2025-12-27
> 來源：[Google Research Blog - Introducing Nested Learning](https://research.google/blog/introducing-nested-learning-a-new-ml-paradigm-for-continual-learning/)

## 概述

Nested Learning 是 Google Research 提出的新 ML 範式，將模型視為多層級互連的優化問題。本文分析其核心概念與 Sleep Agent 的關聯，以及對未來實作的啟示。

## Nested Learning 核心概念

### 主要創新

| 概念 | 說明 |
|------|------|
| **巢狀優化** | 將 ML 模型視為多層級互連的優化問題，而非單一連續過程 |
| **Continuum Memory Systems (CMS)** | 記憶是一個頻譜，每個模組以不同頻率更新 |
| **Deep Optimizers** | 用 L2 regression loss 取代簡單的點積相似度 |
| **Hope 架構** | 自我修改的遞迴 Titans 變體，支援無限層級的上下文學習 |

### Continuum Memory Systems (CMS)

傳統方法只區分短期/長期記憶，CMS 則將記憶視為連續頻譜：

```
高頻更新 ←────────────────────────→ 低頻更新
(工作記憶)                           (長期記憶)
   ↑                                    ↑
每次輸入都更新                      偶爾才更新
快速適應                            穩定保持
```

### Deep Optimizers

傳統 Transformer 使用點積相似度（dot-product similarity），Deep Optimizers 改用 L2 regression loss：

- 更穩健的梯度更新
- 更好的長期知識保留
- 減少災難性遺忘

### Hope 架構

Hope 是 Titans 架構的進化版本：
- 自我修改能力（self-referential processing）
- 無限層級的上下文學習
- CMS 模組支援更大的上下文窗口

## 與 Sleep Agent 的對照

### 1. 多時間尺度記憶更新

**論文觀點**：CMS 以不同頻率更新不同記憶模組

**現有實作**：Sleep Cycle 類型對應此概念

| Cycle 類型 | 觸發條件 | 對應記憶層級 |
|------------|----------|--------------|
| light | 閒置 5 分鐘 | 高頻更新，短期整合 |
| deep | 閒置 30 分鐘 | 低頻更新，長期鞏固 |
| manual | API 調用 | 完整歷史掃描 |

**優化啟示**：可以引入更多層級

```typescript
// 建議的多層級 Cycle 架構
enum SleepCycleType {
  MICRO = 'micro',     // 每 session 結束立即處理
  LIGHT = 'light',     // 閒置 5 分鐘
  MESO = 'meso',       // 每日總結
  DEEP = 'deep',       // 閒置 30 分鐘
  MACRO = 'macro',     // 每週深度分析
  MANUAL = 'manual',   // 手動觸發
}
```

### 2. 災難性遺忘

**論文觀點**：透過架構設計解決新知識覆蓋舊知識的問題

**現有實作**：`supersession` 標記保留舊觀察，而非刪除

```typescript
// 不刪除，只標記關係
db.run(`UPDATE observations SET superseded_by = ? WHERE id = ?`, [newerId, olderId]);
```

**優化啟示**：

1. **遺忘曲線權重** - 被取代的觀察仍可在特定情境下被召回
2. **記憶層級化** - 核心決策永不遺忘，瑣碎觀察可逐漸淡出

```typescript
// 建議的記憶層級
enum MemoryTier {
  CORE = 'core',           // 核心決策，永不遺忘
  WORKING = 'working',     // 工作記憶，活躍使用
  ARCHIVE = 'archive',     // 歸檔，可召回
  EPHEMERAL = 'ephemeral', // 短暫，可清理
}
```

### 3. Deep Optimizers vs 加權平均

**論文觀點**：用 L2 regression loss 取代 dot-product similarity

**現有實作**：信心度計算使用固定權重加權平均

```typescript
// 目前的計算方式
confidence = semanticSimilarity × 0.4
           + topicMatch × 0.2
           + fileOverlap × 0.2
           + typeMatch × 0.2
```

**優化啟示**：用回歸模型取代固定權重

```typescript
// 未來可以考慮的回歸模型方法
interface SupersessionFeatures {
  semanticSimilarity: number;
  topicMatch: number;
  fileOverlap: number;
  typeMatch: number;
  timeDelta: number;
  projectMatch: boolean;
  authorSame: boolean;
}

class LearnedSupersessionModel {
  private weights: Float32Array;

  // 用歷史資料訓練
  train(examples: Array<{features: SupersessionFeatures, label: boolean}>): void {
    // L2 regression training
  }

  // 預測信心度
  predict(features: SupersessionFeatures): number {
    // 回歸預測，而非固定權重
    return this.regression(features);
  }
}
```

### 4. 自我參照處理

**論文觀點**：Hope 架構可以修改自己的參數

**Sleep Agent 應用**：

1. **自動調整閾值** - 根據 supersession 結果回饋調整

```typescript
class AdaptiveThresholdManager {
  private threshold: number = 0.7;

  // 使用者復原被取代的觀察 → 閾值太低
  onUserRevert(observationId: number): void {
    this.threshold += 0.05;
  }

  // 使用者手動標記取代 → 閾值太高
  onUserManualSupersede(oldId: number, newId: number): void {
    this.threshold -= 0.05;
  }
}
```

2. **學習使用者偏好** - 不同類型觀察使用不同閾值

```typescript
interface TypeSpecificThresholds {
  bugfix: number;    // 可能較高，bugfix 通常是明確的取代
  decision: number;  // 可能較低，決策常常是演進而非取代
  discovery: number; // 中等，新發現可能補充舊知識
}
```

### 5. Hope = Titans 的延伸

**重要發現**：Hope 是基於 Titans 架構的進化版本

這驗證了 Sleep Agent 的設計方向正確，且提供了未來進化路徑：

```
Titans (記憶整合)          Hope (自我修改 + 無限層級學習)
       ↓                              ↓
Sleep Agent v1              Sleep Agent v2 (未來)
(supersession)              (自適應閾值 + 多層級記憶)
```

## 效能比較參考

論文中 Hope 架構的效能表現：

| 任務 | Hope vs 基準 |
|------|-------------|
| Language Modeling | 更低的 perplexity |
| Common-Sense Reasoning | 更高的準確率 |
| Long-Context (Needle-In-Haystack) | 優於 TTT 和 Mamba2 |

這些結果顯示多層級記憶和自我修改機制確實有效。

## 未來實作建議

### 優先級矩陣

| 優先級 | 方向 | 來源概念 | 複雜度 | 預估效益 |
|--------|------|----------|--------|----------|
| P0 | 增加 micro cycle | CMS 多頻率 | 低 | 即時處理新觀察 |
| P1 | 自適應閾值調整 | Self-referential | 中 | 減少誤判 |
| P2 | 記憶層級化 | CMS 頻譜 | 中 | 更好的召回策略 |
| P3 | 回歸模型信心度 | Deep Optimizers | 高 | 更準確的取代判斷 |

### P0: Micro Cycle 實作建議

```typescript
// 在 SessionRoutes 的 summary 端點中
async function handleSessionEnd(claudeSessionId: string): Promise<void> {
  // 現有：生成摘要
  await generateSummary(claudeSessionId);

  // 新增：立即處理該 session 的觀察
  const sessionObservations = await getSessionObservations(claudeSessionId);
  for (const obs of sessionObservations) {
    await sleepAgent.checkSupersessionImmediate(obs);
  }
}
```

### P1: 自適應閾值實作建議

```typescript
// 追蹤使用者回饋
interface UserFeedback {
  observationId: number;
  action: 'revert' | 'confirm' | 'manual_supersede';
  timestamp: number;
}

// 定期調整閾值
function adjustThresholds(feedbacks: UserFeedback[]): void {
  const revertRate = feedbacks.filter(f => f.action === 'revert').length / feedbacks.length;

  if (revertRate > 0.1) {
    // 太多復原 → 閾值太低
    increaseThreshold(0.05);
  } else if (revertRate < 0.01) {
    // 幾乎沒有復原 → 閾值可能太高
    decreaseThreshold(0.02);
  }
}
```

### P2: 記憶層級化實作建議

```sql
-- 資料庫變更
ALTER TABLE observations ADD COLUMN memory_tier TEXT DEFAULT 'working';
-- 'core' | 'working' | 'archive' | 'ephemeral'

-- 根據類型和使用頻率自動分級
UPDATE observations
SET memory_tier = 'core'
WHERE type = 'decision' AND reference_count > 5;
```

## 結論

Nested Learning 論文驗證了 Sleep Agent 的設計理念，並提供了明確的進化路線圖：

1. **多層級是正確方向** - CMS 概念支持增加更多 cycle 類型
2. **自我修改能力** - 閾值和權重應該是可學習的，而非固定
3. **Hope 基於 Titans** - 證明 Titans 架構有持續發展空間

## 相關資源

- [Nested Learning 論文](https://research.google/blog/introducing-nested-learning-a-new-ml-paradigm-for-continual-learning/)
- [Titans 論文](https://arxiv.org/abs/2501.00663)
- [Sleep Agent 優化分析](./sleep-agent-optimization.md)
