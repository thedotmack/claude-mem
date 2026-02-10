# Memory Services (P0-P2) 效益驗證方案

## 概述

本文檔定義了驗證 P0-P2 新記憶服務效益的完整測試方案。

## 架構分析

### 現有流程
```
Hook → Observation → SDKAgent → SQLite → Chroma (可選) → SearchManager
```

### 新服務整合點
```
Hook → Observation → WorkingMemory (P1) → SQLite → MemoryCube (P2)
                                          ↓
                                    MemoryFeedback (P0)
```

---

## P0: Memory Feedback Service 驗證

### 目標
驗證自然語言回饋能夠有效修正記憶中的錯誤資訊。

### 測試場景

#### 場景 1: 錯誤資訊修正
```typescript
// 1. 建立包含錯誤資訊的 observation
const wrongObs = {
  title: "API 設計",
  narrative: "使用 POST /api/users/create 來建立使用者",
  type: "decision"
};

// 2. 模擬使用者回饋
const feedback = "POST /api/users/create 是錯的，應該用 POST /api/users";

// 3. 驗證修正後的記憶
// 預期: 新的搜尋結果應該包含修正後的資訊
```

#### 場景 2: 概念更新
```typescript
// 測試概念標籤的更新
const feedback = "這不是 'decision'，應該是 'change' 類型";
```

### 成功指標

| 指標 | 測試方法 | 目標值 |
|------|----------|--------|
| 修正成功率 | 測試已知錯誤的修正 | ≥ 80% |
| 修正後查詢準確度 | 修正前後查詢對比 | 提升 ≥ 30% |
| 誤判率 | 正確記憶被錯誤修正 | ≤ 10% |

### API 測試

```bash
# 1. 建立測試 observation (模擬錯誤資訊)
curl -X POST http://localhost:37777/api/observations \
  -H "Content-Type: application/json" \
  -d '{
    "title": "錯誤測試",
    "narrative": "專案名稱是 claudemem",
    "type": "decision"
  }'

# 2. 搜尋驗證錯誤存在
curl "http://localhost:37777/api/search?query=claudemem"

# 3. 提交回饋修正
curl -X POST http://localhost:37777/api/memory/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "feedback": "專案名稱實際上是 claude-mem 不是 claudemem",
    "memorySessionId": "test-session",
    "project": "claude-mem"
  }'

# 4. 驗證修正
curl "http://localhost:37777/api/search?query=claude-mem"
```

---

## P1: Working Memory Service 驗證

### 目標
驗證雙層記憶快取能夠提升查詢效能並減少資料庫負載。

### 測試場景

#### 場景 1: 快取命中測試
```typescript
// 1. 新增 observation 到 working memory
// 2. 立即搜尋 (應該命中快取)
// 3. 測量回應時間
```

#### 場景 2: LRU 淘汰測試
```typescript
// 1. 新增超過 capacity 的 observations
// 2. 驗證最舊的項目被淘汰
// 3. 驗證淘汰後需要查詢 SQLite
```

#### 場景 3: 冷熱資料分離
```typescript
// 1. 建立熱門項目 (頻繁存取)
// 2. 建立冷門項目 (很少存取)
// 3. 驗證熱門項目留在快取中
```

### 成功指標

| 指標 | 測試方法 | 目標值 |
|------|----------|--------|
| 快取命中率 | 統計 hit/(hit+miss) | ≥ 60% |
| 平均查詢延遲 | 比較有/無快取 | 降低 ≥ 40% |
| 快取穿透率 | 需要查 SQLite 的比例 | ≤ 40% |
| 記憶體使用 | 快取記憶體佔用 | ≤ 50MB |

### 效能基準測試

```typescript
// 測試腳本: benchmark/working-memory.bench.ts
import { performance } from 'perf_hooks';

async function benchmarkWorkingMemory() {
  const iterations = 1000;
  const queries = [
    "API endpoint",
    "memory service",
    "search implementation",
    // ... more queries
  ];

  // 測試無快取 (直接查 SQLite)
  const startWithoutCache = performance.now();
  for (let i = 0; i < iterations; i++) {
    await querySQLite(queries[i % queries.length]);
  }
  const timeWithoutCache = performance.now() - startWithoutCache;

  // 測試有快取 (Working Memory)
  const startWithCache = performance.now();
  for (let i = 0; i < iterations; i++) {
    await queryWithWorkingMemory(queries[i % queries.length]);
  }
  const timeWithCache = performance.now() - startWithCache;

  return {
    withoutCache: timeWithoutCache,
    withCache: timeWithCache,
    improvement: ((timeWithoutCache - timeWithCache) / timeWithoutCache * 100).toFixed(2) + '%'
  };
}
```

### API 測試

```bash
# 1. 檢查快取狀態
curl http://localhost:37777/api/memory/working/stats

# 2. 清空快取
curl -X POST http://localhost:37777/api/memory/working/clear

# 3. 匯出快取內容 (除錯用)
curl http://localhost:37777/api/memory/working/contents

# 4. 測試快取效能
# 先搜尋一次 (cache miss)
time curl "http://localhost:37777/api/search?query=migration"
# 再搜尋一次 (cache hit)
time curl "http://localhost:37777/api/search?query=migration"
```

---

## P2: Memory Cube Service 驗證

### 目標
驗證專案隔離能夠減少跨專案記憶污染並提升查詢精確度。

### 測試場景

#### 場景 1: 專案隔離測試
```typescript
// 1. 建立兩個專案的 cubes
const cubeA = createCube("project-a", "Project A");
const cubeB = createCube("project-b", "Project B");

// 2. 新增相同概念但不同實作
addToCubeA({ title: "API Design", narrative: "REST API for Project A" });
addToCubeB({ title: "API Design", narrative: "GraphQL API for Project B" });

// 3. 搜尋 "API Design"
// 預期: 根據當前專案返回正確的結果
```

#### 場景 2: Cube 合併測試
```typescript
// 1. 建立兩個 cubes
// 2. 合併到目標 cube
// 3. 驗證觀察數量和內容
```

#### 場景 3: 專案切換測試
```typescript
// 1. 設定 active cube
// 2. 搜尋驗證只返回該 cube 的結果
// 3. 切換 cube 再搜尋
```

### 成功指標

| 指標 | 測試方法 | 目標值 |
|------|----------|--------|
| 專案隔離率 | 跨專案搜尋污染比例 | ≤ 5% |
| 查詢精確度 | 相關結果排名 | Top-3 準確率 ≥ 85% |
| 匯出/匯入完整性 | 匯出後匯入驗證 | 100% 一致 |
| Cube 合併正確性 | 合併後資料驗證 | 100% 正確 |

### API 測試

```bash
# 1. 建立專案 cubes
curl -X POST http://localhost:37777/api/memory/cubes \
  -H "Content-Type: application/json" \
  -d '{"cubeId":"project-a","name":"Project A","projectFilter":"project-a"}'

curl -X POST http://localhost:37777/api/memory/cubes \
  -H "Content-Type: application/json" \
  -d '{"cubeId":"project-b","name":"Project B","projectFilter":"project-b"}'

# 2. 列出所有 cubes
curl http://localhost:37777/api/memory/cubes

# 3. 設定 active cube
curl -X POST http://localhost:37777/api/memory/cubes/project-a/set-active

# 4. 獲取 active cube
curl http://localhost:37777/api/memory/cubes/active

# 5. 匯出 cube
curl -X POST http://localhost:37777/api/memory/cubes/project-a/export \
  -H "Content-Type: application/json" \
  -d '{"exportPath":"/tmp/project-a-backup.json"}'

# 6. 合併 cubes
curl -X POST http://localhost:37777/api/memory/cubes/project-a/merge/project-b \
  -H "Content-Type: application/json" \
  -d '{"strategy":"merge","conflictResolution":"keep-existing"}'

# 7. 刪除 cube
curl -X DELETE http://localhost:37777/api/memory/cubes/project-b
```

---

## 整體效益驗證

### A/B 測試框架

```typescript
// test/ab-test/framework.ts
interface ABTestConfig {
  name: string;
  control: () => Promise<any>;
  treatment: () => Promise<any>;
  metrics: (result: any) => Record<string, number>;
  iterations: number;
}

async function runABTest(config: ABTestConfig) {
  const controlResults = [];
  const treatmentResults = [];

  for (let i = 0; i < config.iterations; i++) {
    const controlResult = await config.control();
    const treatmentResult = await config.treatment();

    controlResults.push(config.metrics(controlResult));
    treatmentResults.push(config.metrics(treatmentResult));
  }

  return calculateStats(controlResults, treatmentResults);
}
```

### 綜合測試案例

```typescript
// test/integration/memory-services.integration.test.ts
describe('Memory Services Integration', () => {
  test('完整流程: Working Memory → Memory Cube → Memory Feedback', async () => {
    // 1. 建立 observation
    // 2. 驗證 Working Memory 快取
    // 3. 驗證 Memory Cube 隔離
    // 4. 模擬回饋修正
    // 5. 驗證修正結果
  });

  test('效能對比: 有/無新服務', async () => {
    // 比較啟用/停用新服務的查詢效能
  });

  test('記憶品質: 修正前後對比', async () => {
    // 比較修正前後的搜尋結果品質
  });
});
```

---

## 監控指標 (Production)

### 要設置的指標

```typescript
// metrics/memory-services.metrics.ts
export const memoryServiceMetrics = {
  // P0: Memory Feedback
  feedbackReceived: Counter('memory_feedback_received_total'),
  feedbackProcessed: Counter('memory_feedback_processed_total'),
  feedbackErrors: Counter('memory_feedback_errors_total'),
  correctionAccuracy: Gauge('memory_feedback_accuracy'),

  // P1: Working Memory
  cacheHits: Counter('working_memory_cache_hits_total'),
  cacheMisses: Counter('working_memory_cache_misses_total'),
  cacheSize: Gauge('working_memory_size'),
  cacheEvictions: Counter('working_memory_evictions_total'),
  avgQueryLatency: Histogram('working_memory_query_latency_ms'),

  // P2: Memory Cube
  cubeOperations: Counter('memory_cube_operations_total', ['operation']),
  cubeIsolationViolations: Counter('memory_cube_isolation_violations_total'),
  activeCube: Gauge('memory_cube_active'),
};
```

### Dashboard 指標

| 服務 | 指標 | 警告臨界值 |
|------|------|------------|
| P0 | Feedback 錯誤率 | > 20% |
| P1 | Cache 命中率 | < 50% |
| P1 | 平均查詢延遲 | > 100ms |
| P2 | 隔離違規 | > 0 |

---

## 實施時間表

### Phase 1: 基礎測試 (1 週)
- [ ] 完成 API 測試腳本
- [ ] 建立測試資料集
- [ ] 執行單元測試

### Phase 2: 效能基準 (1 週)
- [ ] 建立效能基準測試
- [ ] 執行 A/B 測試
- [ ] 收集效能數據

### Phase 3: 整合驗證 (1 週)
- [ ] 執行整合測試
- [ ] 驗證端到端流程
- [ ] 分析整體效益

### Phase 4: 生產監控 (持續)
- [ ] 部署監控指標
- [ ] 設置 Dashboard
- [ ] 建立警報規則

---

## 預期效益

### P0: Memory Feedback
- 記憶準確度提升 30%
- 減少重複錯誤 50%
- 使用者滿意度提升

### P1: Working Memory
- 查詢延遲降低 40%
- 資料庫負載減少 60%
- 熱門查詢回應時間 < 50ms

### P2: Memory Cube
- 跨專案記憶污染降低 90%
- 查詢精確度提升 25%
- 團隊協作效率提升

### 綜合
- 整體記憶系統可靠性提升
- 多專案管理更清晰
- 長期維護成本降低
