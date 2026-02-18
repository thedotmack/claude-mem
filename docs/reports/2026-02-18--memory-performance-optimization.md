# 2026-02-18 — claude-mem 메모리/성능 최적화 작업 기록

## 배경
최근 `claude-mem` 워커의 RSS 메모리 사용량이 높게 관찰되어(검색 1회 후 급상승),
소스 코드 기준으로 메모리 증가 요인을 점검하고 즉시 적용 가능한 최적화를 반영했다.

## 적용한 변경사항

### 1) Conversation history bounded trim 도입
- 신규 파일:
  - `src/services/worker/session/ConversationHistoryManager.ts`
- 핵심 로직:
  - `MAX_HISTORY_MESSAGES = 80`
  - `MAX_HISTORY_CHARS = 200_000`
  - 메시지 append 시 상한 초과분을 앞쪽(오래된 항목)부터 제거
- 효과:
  - 장시간 세션에서 `conversationHistory` 무한 증가 방지
  - provider 전환 컨텍스트는 유지하면서 메모리 상한 확보

### 2) 모든 provider 경로에서 history append를 공통 유틸로 통합
- 수정 파일:
  - `src/services/worker/SDKAgent.ts`
  - `src/services/worker/GeminiAgent.ts`
  - `src/services/worker/OpenRouterAgent.ts`
  - `src/services/worker/agents/ResponseProcessor.ts`
- 변경 내용:
  - 직접 `session.conversationHistory.push(...)` 호출을
    `appendConversationMessage(...)`로 교체

### 3) Gemini 경로의 assistant history 중복 적재 제거
- 수정 파일:
  - `src/services/worker/GeminiAgent.ts`
  - `src/services/worker/agents/ResponseProcessor.ts`
- 변경 내용:
  - GeminiAgent에서 assistant 응답 push를 제거하고,
    `processAgentResponse()`에서 단일 경로로 append
- 효과:
  - 동일 assistant 응답이 history에 2회 들어가는 문제 제거

### 4) Chroma sync session ID 전달 버그 수정
- 수정 파일:
  - `src/services/worker/agents/ResponseProcessor.ts`
- 변경 내용:
  - `syncObservation/syncSummary` 호출 시
    `session.contentSessionId` → `session.memorySessionId`로 수정
- 효과:
  - 저장/동기화 경로의 세션 식별자 일관성 개선

### 5) 임베딩 메모리 절감을 위해 uint8 적용
- 수정 파일:
  - `src/services/sync/ChromaSync.ts`
- 변경 내용:
  - `new DefaultEmbeddingFunction({ wasm: true, dtype: 'uint8' })`
- 효과:
  - 임베딩 모델 로드/추론 시 메모리 풋프린트 감소 기대

## 검증

### 빌드
- 명령:
  - `npm run build`
- 결과:
  - worker/mcp/context 번들 빌드 성공

### 런타임 관찰(로컬)
- 조건:
  - 워커 재시작 후 동일 검색 API 1회 실행
- 관찰:
  - 이전 관찰치(기존 프로세스): RSS 약 **748MB**
  - 변경 후 신규 프로세스: RSS 약 **280MB** (검색 1회 후)
- 비고:
  - 구 워커 프로세스 1개가 동시에 남아 있던 상태가 있었고,
    수동 종료하여 단일 프로세스로 정리함

## 배포/적용 메모
- 소스에서 빌드한 뒤 cache 실행본(`~/.claude/plugins/cache/.../scripts`)에 반영 후 재시작하여 확인
- cache 경로에는 백업 파일(`*.bak-YYYYMMDD-HHMMSS`) 생성

## 롤백 가이드
1. cache 배포본은 `*.bak-*` 파일로 즉시 롤백 가능
2. 소스는 git commit 단위로 `git revert <commit>` 권장

## 후속 권장
- load test(연속 검색/장시간 세션)로 RSS 추이 추가 측정
- OpenRouter/Gemini fallback 반복 시 history trimming 로그 모니터링
- 필요 시 `MAX_HISTORY_MESSAGES`, `MAX_HISTORY_CHARS`를 settings 기반으로 외부화
