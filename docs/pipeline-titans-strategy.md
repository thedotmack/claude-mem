# Pipeline + Titans 戰略規劃

> **Created**: 2026-02-16
> **Context**: PR #464 closed by maintainer - recommend fresh PR against current main
> **Focus**: Pipeline Architecture + Titans Memory System as unique contribution

## 核心理念

```
┌─────────────────────────────────────────────────────────────────┐
│                    你的獨特貢獻                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Pipeline Architecture          Titans Memory System           │
│   ─────────────────────          ────────────────────           │
│   • 5-stage processing            • Importance Scoring          │
│   • Stage isolation               • Surprise Detection          │
│   • Checkpoint/Resume             • Memory Tiering              │
│   • Cost estimation               • Adaptive Forgetting         │
│                                                                 │
│   = HOW observations flow         = WHAT value they provide     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 架構對比

### 當前 Main 架構（簡化）
```
Agent Response → parseObservations() → storeObservations() → Chroma Sync
                        ↓
                  單一函數處理所有邏輯
```

### 目標架構
```
Agent Response
      ↓
┌─────────────────────────────────────────────────────────┐
│  PIPELINE (5-Stage)                                     │
│  ─────────────────                                       │
│  Acquire → Prepare → Process → Parse → Render           │
│     ↓          ↓          ↓         ↓        ↓          │
│   [原始     [提示詞     [LLM      [結構化   [DB +       │
│    輸出]     建構]      壓縮]     解析]     Chroma]     │
│                                                         │
│  + Checkpoint/Resume                                    │
│  + Stage Metrics                                        │
│  + Cost Estimation                                      │
└─────────────────────────────────────────────────────────┘
      ↓
┌─────────────────────────────────────────────────────────┐
│  TITANS (Intelligence Layer)                            │
│  ─────────────────────────                               │
│  • AccessTracker → 追蹤存取模式                          │
│  • ImportanceScorer → 多因子重要性評分                   │
│  • SurpriseMetric → 驚喜檢測 + Momentum                  │
│  • MemoryTier → core/working/archive/ephemeral          │
│  • ForgettingPolicy → 智能遺忘                          │
└─────────────────────────────────────────────────────────┘
```

---

## PR 序列規劃

### PR #1: Pipeline Foundation（核心基礎）

**目標**: 建立 5-stage pipeline 架構

| 項目 | 內容 |
|------|------|
| **新增檔案** | `src/services/pipeline/index.ts` |
| | `src/services/pipeline/stages/acquire.ts` |
| | `src/services/pipeline/stages/prepare.ts` |
| | `src/services/pipeline/stages/process.ts` |
| | `src/services/pipeline/stages/parse.ts` |
| | `src/services/pipeline/stages/render.ts` |
| **修改檔案** | `src/services/worker/agents/ResponseProcessor.ts` |
| **規模** | ~800-1000 行 |
| **依賴** | 無（獨立模組） |
| **價值** | 重構核心架構，可獨立測試每個階段 |

**關鍵創新**:
```typescript
// Pipeline 可以單獨測試每個階段
const result = await pipeline.execute(rawInput, {
  resumeFrom: 'parse',  // 從 Parse 階段重試，不需重新呼叫 LLM
  checkpoint: true,     // 啟用檢查點
});
```

---

### PR #2: Titans Core - Importance System

**目標**: 建立重要性評分基礎

| 項目 | 內容 |
|------|------|
| **新增檔案** | `src/services/worker/AccessTracker.ts` |
| | `src/services/worker/ImportanceScorer.ts` |
| | `src/services/worker/SemanticRarity.ts` |
| **資料庫** | Migration: `memory_access` table + `importance_score` column |
| **API** | `GET /api/memory/:id/stats`, `GET /api/memory/rare` |
| **規模** | ~600-800 行 |
| **依賴** | PR #1064 (Chroma backfill) - **需要等待** |
| **價值** | 為記憶提供「價值」評估能力 |

**關鍵創新**:
```typescript
// 多因子重要性評分
const score = importanceScorer.calculate(observation, {
  type: 0.25,      // 決策類型權重
  rarity: 0.25,    // 語意稀有度
  access: 0.25,    // 存取頻率
  age: 0.25        // 時間衰減
});
```

---

### PR #3: Titans Advanced - Surprise & Momentum

**目標**: 驚喜檢測 + 動量緩衝

| 項目 | 內容 |
|------|------|
| **新增檔案** | `src/services/worker/SurpriseMetric.ts` |
| | `src/services/worker/MomentumBuffer.ts` |
| **資料庫** | Migration: `surprise_score`, `surprise_tier` columns |
| **API** | `GET /api/surprise/:id`, `GET /api/surprising` |
| **規模** | ~700-900 行 |
| **依賴** | PR #2 (Importance System) |
| **價值** | 檢測「新奇」資訊，提升重要話題權重 |

**關鍵創新**:
```typescript
// 驚喜檢測（語意距離 + 時間衰減）
const surprise = surpriseMetric.calculate(observation);
if (surprise.score > threshold) {
  momentumBuffer.boost(observation.topic, duration: 30min);
}
```

---

### PR #4: Pipeline + Titans Integration

**目標**: 整合 Pipeline 與 Titans

| 項目 | 內容 |
|------|------|
| **修改** | Pipeline Render stage 加入 Titans 評分 |
| **新增** | `ForgettingPolicy.ts` - 基於評分的遺忘決策 |
| **API** | `POST /api/cleanup/run` - 智能清理 |
| **規模** | ~400-500 行 |
| **依賴** | PR #1 + PR #2 + PR #3 |
| **價值** | **整合成果** - Pipeline 流程中自動評分 |

**架構圖**:
```
Acquire → Prepare → Process → Parse → Render
                                      ↓
                              ┌───────────────┐
                              │ Titans Layer  │
                              │ • Importance  │
                              │ • Surprise    │
                              │ • Memory Tier │
                              └───────────────┘
                                      ↓
                              [DB + Chroma]
```

---

### PR #5: Sleep Agent（可選 - 高級功能）

**目標**: 後台記憶整合代理

| 項目 | 內容 |
|------|------|
| **新增檔案** | `src/services/worker/SleepAgent.ts` |
| | `src/services/worker/SupersessionDetector.ts` |
| | `src/services/worker/LearnedSupersessionModel.ts` |
| **規模** | ~1500-2000 行 |
| **依賴** | PR #1-4 全部 |
| **價值** | 多時間尺度記憶整合，學習型取代檢測 |

---

## 依賴關係圖

```
                    ┌─────────────────┐
                    │  PR #1064       │
                    │  Chroma Backfill│
                    └────────┬────────┘
                             │ (等待合併)
                             ↓
┌────────────────────────────────────────────────────────────┐
│                                                            │
│   PR #1: Pipeline ──────────────────────────────┐          │
│   (獨立，可立即開始)                              │          │
│                                                  │          │
└──────────────────────────────────────────────────┼──────────┘
                                                   │
                   ┌───────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   PR #2: Titans Core (Importance) ──────────────┐           │
│                                                  │           │
└──────────────────────────────────────────────────┼───────────┘
                                                   │
                   ┌───────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   PR #3: Titans Advanced (Surprise) ────────────┐           │
│                                                  │           │
└──────────────────────────────────────────────────┼───────────┘
                                                   │
                   ┌───────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   PR #4: Integration ───────────────────────────┐           │
│                                                  │           │
└──────────────────────────────────────────────────┼───────────┘
                                                   │
                   ┌───────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   PR #5: Sleep Agent (可選) ─────────────────────┐           │
│                                                  │           │
└─────────────────────────────────────────────────────────────┘
```

---

## Open PRs 相容性分析

### 必須先等待合併（基礎設施修復）

| PR | 說明 | 與本計畫關係 |
|----|------|-------------|
| #1102 | Critical bug fixes | 應先合併，穩定基礎 |
| #1121 | FK constraint fix | 修改 SessionStore，需注意 |
| #1085 | Process spawn stabilization | 建議先合併 |

### 功能相關/可協調

| PR | 說明 | 與本計畫關係 |
|----|------|-------------|
| #1064 | Chroma backfill | **PR #2 依賴此 PR** |
| #1083 | Thoughts timeline | 平行功能，無衝突 |
| #1088 | Persistent venv | Chroma 基礎設施 |

---

## 時程規劃

| 階段 | PR | 預估時間 | 累計 |
|------|-----|---------|------|
| Phase 1 | Pipeline Foundation | 1-2 週 | 2 週 |
| Phase 2 | Titans Core | 1-2 週 | 4 週 |
| Phase 3 | Titans Advanced | 1-2 週 | 6 週 |
| Phase 4 | Integration | 1 週 | 7 週 |
| Phase 5 | Sleep Agent (可選) | 2-3 週 | 10 週 |

---

## 參考文件

### 內部文件
- [Pipeline Architecture Analysis](./pipeline-architecture-analysis.md)
- [Nested Learning Analysis](./nested-learning-analysis.en.md)
- [Titans Integration Status](./titans-integration-status.md)
- [PR #464 Implementation Summary](./pr-464-implementation-summary.md)

### 外部參考來源

#### Mem0 - 記憶管理架構參考
- **GitHub**: https://github.com/mem0ai/mem0
- **論文**: [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413)
- **參考內容**:
  - Extraction → Update Pipeline 架構啟發了 5-stage Pipeline 設計
  - Multi-level Memory (Short-term → Long-term) 概念對應 Memory Tier
  - LLM 決策引擎（Add/Update/Delete/NOOP）啟發了衝突處理機制
  - 最佳實踐參數：M=10（context window）、S=10（相似記憶檢索）

#### Google Titans Paper - 驚喜檢測與動量
- **論文**: [Learning to Memorize at Test Time](https://arxiv.org/abs/2504.19413) (參考 Mem0 引用)
- **參考內容**:
  - Surprise Metric（驚喜檢測）- 偵測語意距離和時間衰減
  - Momentum Buffer（動量緩衝）- 提升重要話題權重
  - 這些概念應用於 `SurpriseMetric.ts` 和 `MomentumBuffer.ts`

#### Mem0 Graph Memory - 知識圖譜設計（未來參考）
- **文檔**: https://docs.mem0.ai/open-source/features/graph-memory
- **參考內容**:
  - Entity-Relation 知識圖譜 G=(V,E,L)
  - Update Resolver 衝突解決機制
  - 多圖資料庫支援（Neo4j, Memgraph, Neptune, Kuzu）

---

## 變更歷史

| 日期 | 變更 |
|------|------|
| 2026-02-16 | 初版 - 基於 PR #464 關閉後的重新規劃 |
