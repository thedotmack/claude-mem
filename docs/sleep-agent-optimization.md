# Sleep Agent 效能分析與優化方向

> 建立日期：2025-12-27
> 狀態：已實作基礎版本，待優化

## 概述

Sleep Agent 是一個背景記憶整合系統，靈感來自 Google Titans 論文。在系統閒置期間執行 Sleep Cycle，偵測並標記被取代的觀察（supersession），減少記憶噪音。

## 目前實作

### 核心元件

| 檔案 | 職責 |
|------|------|
| `src/services/worker/SleepAgent.ts` | 主協調器，管理閒置偵測與 cycle 執行 |
| `src/services/worker/SupersessionDetector.ts` | 語義相似度偵測，計算取代信心度 |
| `src/services/worker/http/routes/SleepRoutes.ts` | HTTP API 端點 |

### 演算法流程

```
1. 取得最近 N 天內的活躍觀察
2. 對每對觀察 (older, newer)：
   a. 檢查類型匹配（同類型才可能取代）
   b. 檢查專案匹配
   c. 檢查時間差（不超過 maxAgeDifferenceHours）
   d. 查詢 Chroma 計算語義相似度
   e. 計算主題匹配、檔案重疊
   f. 綜合計算信心度
3. 對信心度超過閾值的候選，標記 superseded_by
```

### 信心度計算公式

```
confidence = semanticSimilarity × 0.4
           + topicMatch × 0.2
           + fileOverlap × 0.2
           + typeMatch × 0.2
```

## 效能特性

### 時間複雜度

- **最壞情況**：O(N²) Chroma 查詢
- **實際情況**：因提前過濾（類型、專案、時間差），實際查詢數遠少於 N²

### 實測數據

| 觀察數 | 執行時間 | 備註 |
|--------|----------|------|
| 54 | ~58 秒 | Light cycle, dry run |
| 104 | ~238 秒 | Light cycle, real |
| 504 | ~1 秒 | 可能使用 fallback |

### 規模定義

| 規模 | 觀察數 | 預估時間 | 典型場景 |
|------|--------|----------|----------|
| 小型 | < 100 | < 1 分鐘 | 單日工作 |
| 中型 | 100-500 | 1-10 分鐘 | 一週工作 |
| 大型 | 500-1000 | 10-60 分鐘 | 一個月工作 |
| 超大型 | > 1000 | 數小時 | 完整歷史 |

## 已知限制

1. **Chroma 查詢瓶頸**：每對觀察需要一次 Chroma MCP 呼叫
2. **無法平行化**：目前串行處理所有候選對
3. **完整歷史處理慢**：6000+ 觀察的完整分析需要數小時
4. **無增量處理**：每次 cycle 都重新分析所有觀察

## 優化方向

### 方向 1：批次查詢 Chroma

**做法**：將多個語義相似度查詢打包成一次 API 呼叫

**優點**：
- 減少網路/IPC 往返延遲
- Chroma 內部可優化批次運算
- 實作相對簡單

**缺點**：
- Chroma MCP 協議可能不支援批次
- 大批次可能超出記憶體限制
- 仍需為每筆計算嵌入向量

**實作複雜度**：中等
**預估效益**：2-5x 加速

**實作要點**：
```typescript
// 目前：逐一查詢
for (const obs of observations) {
  const similarity = await chromaSync.queryChroma(obs.narrative, 50);
}

// 優化：批次查詢
const queries = observations.map(obs => obs.narrative);
const similarities = await chromaSync.batchQueryChroma(queries, 50);
```

---

### 方向 2：預計算嵌入向量

**做法**：在觀察建立時就儲存嵌入向量到 SQLite，直接做向量運算

**優點**：
- 最快 - 純數學運算，無網路呼叫
- 可平行化向量運算（SIMD）
- 一次計算，永久使用
- 可做離線分析

**缺點**：
- 儲存開銷大（每觀察約 6KB，768-1536 floats）
- 需要取得嵌入模型（目前透過 Chroma MCP）
- 寫入路徑變複雜
- 需同步機制確保一致性

**實作複雜度**：高
**預估效益**：10-100x 加速

**資料庫變更**：
```sql
ALTER TABLE observations ADD COLUMN embedding BLOB;
CREATE INDEX idx_observations_embedding ON observations(embedding);
```

**相似度計算**：
```typescript
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

---

### 方向 3：增量處理新觀察

**做法**：只處理新觀察 vs 最近觀察，不重跑完整歷史

**優點**：
- 恆定時間，不隨歷史增長
- 可即時處理（每次 PostToolUse 或 session 結束）
- 最少改動現有程式碼
- 記憶體使用穩定

**缺點**：
- 可能錯過跨長時間的取代關係
- 需追蹤「已處理」狀態
- 補跑/重跑有邊界情況
- 假設取代主要發生在近期

**實作複雜度**：低-中
**預估效益**：O(N²) → O(1) 每次處理

**資料庫變更**：
```sql
ALTER TABLE observations ADD COLUMN supersession_checked INTEGER DEFAULT 0;
ALTER TABLE observations ADD COLUMN supersession_checked_at INTEGER;
```

**處理邏輯**：
```typescript
async function processNewObservation(newObs: ObservationRow): Promise<void> {
  // 只比較最近 7 天、同專案、同類型的觀察
  const candidates = await getRecentObservations({
    project: newObs.project,
    type: newObs.type,
    lookbackDays: 7,
    excludeId: newObs.id,
  });

  for (const candidate of candidates) {
    const result = await checkSupersessionPair(candidate, newObs);
    if (result && result.confidence >= threshold) {
      await applySupersession(result);
    }
  }

  await markAsChecked(newObs.id);
}
```

---

## 推薦實作策略

### 短期（低成本高效益）

```
增量處理 + 定期完整掃描
```

1. **即時處理**：Session 結束時處理該 session 的新觀察
2. **Light Sleep**：只處理最近 7 天未檢查的觀察
3. **Deep Sleep**：每週一次完整歷史掃描（可在夜間執行）

### 長期（高投資高回報）

```
預計算嵌入 + 增量處理 + 向量索引
```

1. **寫入時計算**：觀察建立時同步儲存嵌入向量
2. **即時比對**：新觀察用餘弦相似度與近期觀察比對
3. **向量索引**：使用 FAISS 或 SQLite VSS 加速大規模搜尋
4. **Sleep Cycle**：變成毫秒級操作

## 優先級建議

| 優先級 | 優化方向 | 原因 |
|--------|----------|------|
| P0 | 增量處理 | 最低成本，立即可見效益 |
| P1 | 批次查詢 | 中等成本，與增量處理互補 |
| P2 | 預計算嵌入 | 高成本，但是終極解決方案 |

## 相關資源

- [Titans 論文](https://arxiv.org/abs/2501.00663) - 記憶整合理論基礎
- [Chroma MCP](https://github.com/chroma-core/chroma) - 向量資料庫
- [SQLite VSS](https://github.com/asg017/sqlite-vss) - SQLite 向量搜尋擴展
