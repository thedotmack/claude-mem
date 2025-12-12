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

<h4 align="center"><a href="https://claude.com/claude-code" target="_blank">Claude Code</a>를 위해 구축된 지속적 메모리 압축 시스템.</h4>

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
  <a href="#빠른-시작">빠른 시작</a> •
  <a href="#작동-방식">작동 방식</a> •
  <a href="#mcp-검색-도구">검색 도구</a> •
  <a href="#문서">문서</a> •
  <a href="#설정">설정</a> •
  <a href="#문제-해결">문제 해결</a> •
  <a href="#라이선스">라이선스</a>
</p>

<p align="center">
  Claude-Mem은 도구 사용 관찰 내용을 자동으로 캡처하고 의미론적 요약을 생성하여 향후 세션에서 사용할 수 있도록 함으로써 세션 간 컨텍스트를 원활하게 보존합니다. 이를 통해 Claude는 세션이 종료되거나 재연결된 후에도 프로젝트에 대한 지식의 연속성을 유지할 수 있습니다.
</p>

---

## 빠른 시작

터미널에서 새로운 Claude Code 세션을 시작하고 다음 명령을 입력하세요:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Claude Code를 재시작하세요. 이전 세션의 컨텍스트가 자동으로 새 세션에 나타납니다.

**주요 기능:**

- 🧠 **지속적 메모리** - 세션 간 컨텍스트 유지
- 📊 **점진적 공개** - 토큰 비용 가시성을 갖춘 계층화된 메모리 검색
- 🔍 **스킬 기반 검색** - mem-search 스킬로 프로젝트 기록 쿼리 (~2,250 토큰 절약)
- 🖥️ **웹 뷰어 UI** - http://localhost:37777에서 실시간 메모리 스트림
- 💻 **Claude Desktop 스킬** - Claude Desktop 대화에서 메모리 검색
- 🔒 **프라이버시 제어** - `<private>` 태그를 사용하여 민감한 콘텐츠를 저장소에서 제외
- ⚙️ **컨텍스트 설정** - 주입되는 컨텍스트에 대한 세밀한 제어
- 🤖 **자동 작동** - 수동 개입 불필요
- 🔗 **인용** - `claude-mem://` URI로 과거 결정 참조
- 🧪 **베타 채널** - 버전 전환을 통해 Endless Mode와 같은 실험적 기능 시도

---

## 문서

📚 **[전체 문서 보기](docs/)** - GitHub에서 마크다운 문서 탐색

💻 **로컬 미리보기**: Mintlify 문서를 로컬에서 실행:

```bash
cd docs
npx mintlify dev
```

### 시작하기

- **[설치 가이드](https://docs.claude-mem.ai/installation)** - 빠른 시작 및 고급 설치
- **[사용 가이드](https://docs.claude-mem.ai/usage/getting-started)** - Claude-Mem이 자동으로 작동하는 방법
- **[검색 도구](https://docs.claude-mem.ai/usage/search-tools)** - 자연어로 프로젝트 기록 쿼리
- **[베타 기능](https://docs.claude-mem.ai/beta-features)** - Endless Mode와 같은 실험적 기능 시도

### 모범 사례

- **[컨텍스트 엔지니어링](https://docs.claude-mem.ai/context-engineering)** - AI 에이전트 컨텍스트 최적화 원칙
- **[점진적 공개](https://docs.claude-mem.ai/progressive-disclosure)** - Claude-Mem의 컨텍스트 프라이밍 전략 철학

### 아키텍처

- **[개요](https://docs.claude-mem.ai/architecture/overview)** - 시스템 구성 요소 및 데이터 흐름
- **[아키텍처 진화](https://docs.claude-mem.ai/architecture-evolution)** - v3에서 v5로의 여정
- **[훅 아키텍처](https://docs.claude-mem.ai/hooks-architecture)** - Claude-Mem이 라이프사이클 훅을 사용하는 방법
- **[훅 참조](https://docs.claude-mem.ai/architecture/hooks)** - 7개 훅 스크립트 설명
- **[워커 서비스](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API 및 PM2 관리
- **[데이터베이스](https://docs.claude-mem.ai/architecture/database)** - SQLite 스키마 및 FTS5 검색
- **[검색 아키텍처](https://docs.claude-mem.ai/architecture/search-architecture)** - Chroma 벡터 데이터베이스를 사용한 하이브리드 검색

### 설정 및 개발

- **[설정](https://docs.claude-mem.ai/configuration)** - 환경 변수 및 설정
- **[개발](https://docs.claude-mem.ai/development)** - 빌드, 테스트, 기여
- **[문제 해결](https://docs.claude-mem.ai/troubleshooting)** - 일반적인 문제 및 솔루션

---

## 작동 방식

```
┌─────────────────────────────────────────────────────────────┐
│ 세션 시작 → 최근 관찰 내용을 컨텍스트로 주입                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 사용자 프롬프트 → 세션 생성, 사용자 프롬프트 저장           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 도구 실행 → 관찰 내용 캡처 (Read, Write 등)                 │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 워커 프로세스 → Claude Agent SDK를 통한 학습 내용 추출      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 세션 종료 → 요약 생성, 다음 세션 준비                       │
└─────────────────────────────────────────────────────────────┘
```

**핵심 구성 요소:**

1. **5개 라이프사이클 훅** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6개 훅 스크립트)
2. **스마트 설치** - 캐시된 종속성 검사기 (사전 훅 스크립트, 라이프사이클 훅 아님)
3. **워커 서비스** - 웹 뷰어 UI와 10개 검색 엔드포인트를 갖춘 포트 37777의 HTTP API, PM2로 관리
4. **SQLite 데이터베이스** - FTS5 전문 검색을 갖춘 세션, 관찰 내용, 요약 저장
5. **mem-search 스킬** - 점진적 공개를 통한 자연어 쿼리 (~2,250 토큰 절약 vs MCP)
6. **Chroma 벡터 데이터베이스** - 지능형 컨텍스트 검색을 위한 하이브리드 의미론적 + 키워드 검색

자세한 내용은 [아키텍처 개요](https://docs.claude-mem.ai/architecture/overview)를 참조하세요.

---

## mem-search 스킬

Claude-Mem은 과거 작업에 대해 질문할 때 자동으로 호출되는 mem-search 스킬을 통해 지능형 검색을 제공합니다:

**작동 방식:**
- 자연스럽게 질문하세요: *"지난 세션에서 무엇을 했나요?"* 또는 *"이 버그를 이전에 수정했나요?"*
- Claude가 자동으로 mem-search 스킬을 호출하여 관련 컨텍스트를 찾습니다
- MCP 방식 대비 세션 시작당 ~2,250 토큰 절약

**사용 가능한 검색 작업:**

1. **관찰 내용 검색** - 관찰 내용 전체에 대한 전문 검색
2. **세션 검색** - 세션 요약 전체에 대한 전문 검색
3. **프롬프트 검색** - 원시 사용자 요청 검색
4. **개념별** - 개념 태그로 찾기 (discovery, problem-solution, pattern 등)
5. **파일별** - 특정 파일을 참조하는 관찰 내용 찾기
6. **유형별** - 유형별 찾기 (decision, bugfix, feature, refactor, discovery, change)
7. **최근 컨텍스트** - 프로젝트의 최근 세션 컨텍스트 가져오기
8. **타임라인** - 특정 시점 주변의 통합 컨텍스트 타임라인 가져오기
9. **쿼리별 타임라인** - 관찰 내용을 검색하고 최적 일치 항목 주변의 타임라인 컨텍스트 가져오기
10. **API 도움말** - 검색 API 문서 가져오기

**자연어 쿼리 예시:**

```
"지난 세션에서 어떤 버그를 수정했나요?"
"인증을 어떻게 구현했나요?"
"worker-service.ts에 어떤 변경 사항이 적용되었나요?"
"이 프로젝트의 최근 작업을 보여주세요"
"뷰어 UI를 추가할 때 무슨 일이 있었나요?"
```

자세한 예시는 [검색 도구 가이드](https://docs.claude-mem.ai/usage/search-tools)를 참조하세요.

---

## 베타 기능 및 Endless Mode

Claude-Mem은 실험적 기능이 포함된 **베타 채널**을 제공합니다. 웹 뷰어 UI에서 직접 안정 버전과 베타 버전을 전환할 수 있습니다.

### 베타 시도 방법

1. http://localhost:37777 열기
2. 설정 클릭 (톱니바퀴 아이콘)
3. **Version Channel**에서 "Try Beta (Endless Mode)" 클릭
4. 워커가 재시작될 때까지 대기

버전을 전환해도 메모리 데이터는 보존됩니다.

### Endless Mode (베타)

대표적인 베타 기능은 **Endless Mode**입니다 - 세션 길이를 극적으로 연장하는 생체모방 메모리 아키텍처:

**문제점**: 표준 Claude Code 세션은 약 50번의 도구 사용 후 컨텍스트 한계에 도달합니다. 각 도구는 1-10k+ 토큰을 추가하며, Claude는 모든 응답마다 이전의 모든 출력을 재합성합니다 (O(N²) 복잡도).

**솔루션**: Endless Mode는 도구 출력을 약 500토큰 관찰 내용으로 압축하고 실시간으로 트랜스크립트를 변환합니다:

```
작업 메모리 (컨텍스트):     압축된 관찰 내용 (각 ~500 토큰)
아카이브 메모리 (디스크):    회상을 위해 보존된 전체 도구 출력
```

**예상 결과**:
- 컨텍스트 창에서 ~95% 토큰 감소
- 컨텍스트 소진 전까지 약 20배 더 많은 도구 사용
- 이차 O(N²) 대신 선형 O(N) 확장
- 완벽한 회상을 위해 전체 트랜스크립트 보존

**주의사항**: 지연 시간 추가 (관찰 생성당 60-90초), 여전히 실험 단계.

자세한 내용은 [베타 기능 문서](https://docs.claude-mem.ai/beta-features)를 참조하세요.

---

## 새로운 기능

**v6.4.9 - 컨텍스트 설정:**
- 컨텍스트 주입에 대한 세밀한 제어를 위한 11개의 새로운 설정
- 토큰 경제성 표시, 유형/개념별 관찰 내용 필터링 구성
- 관찰 내용 수 및 표시할 필드 제어

**v6.4.0 - 이중 태그 프라이버시 시스템:**
- 사용자 제어 프라이버시를 위한 `<private>` 태그 - 민감한 콘텐츠를 래핑하여 저장소에서 제외
- 시스템 레벨 `<claude-mem-context>` 태그는 재귀적 관찰 저장 방지
- 엣지 처리로 프라이빗 콘텐츠가 데이터베이스에 도달하지 않도록 보장

**v6.3.0 - 버전 채널:**
- 웹 뷰어 UI에서 안정 버전과 베타 버전 전환
- 수동 git 작업 없이 Endless Mode와 같은 실험적 기능 시도

**이전 하이라이트:**
- **v6.0.0**: 주요 세션 관리 및 트랜스크립트 처리 개선
- **v5.5.0**: 100% 효과율을 갖춘 mem-search 스킬 향상
- **v5.4.0**: 스킬 기반 검색 아키텍처 (세션당 ~2,250 토큰 절약)
- **v5.1.0**: 실시간 업데이트를 갖춘 웹 기반 뷰어 UI
- **v5.0.0**: Chroma 벡터 데이터베이스를 사용한 하이브리드 검색

전체 버전 기록은 [CHANGELOG.md](CHANGELOG.md)를 참조하세요.

---

## 시스템 요구사항

- **Node.js**: 18.0.0 이상
- **Claude Code**: 플러그인 지원이 포함된 최신 버전
- **PM2**: 프로세스 매니저 (번들 포함 - 전역 설치 불필요)
- **SQLite 3**: 지속적 저장을 위해 (번들 포함)

---

## 주요 이점

### 점진적 공개 컨텍스트

- **계층화된 메모리 검색**은 인간의 기억 패턴을 반영
- **레이어 1 (인덱스)**: 세션 시작 시 토큰 비용과 함께 존재하는 관찰 내용 확인
- **레이어 2 (세부사항)**: MCP 검색을 통해 필요에 따라 전체 내러티브 가져오기
- **레이어 3 (완벽한 회상)**: 소스 코드 및 원본 트랜스크립트 액세스
- **스마트 의사결정**: 토큰 수는 Claude가 세부 정보 가져오기 또는 코드 읽기 중에서 선택하는 데 도움
- **유형 표시기**: 시각적 단서 (🔴 중요, 🟤 결정, 🔵 정보) 관찰 내용의 중요도 강조

### 자동 메모리

- Claude 시작 시 자동으로 컨텍스트 주입
- 수동 명령이나 구성 불필요
- 백그라운드에서 투명하게 작동

### 전체 기록 검색

- 모든 세션 및 관찰 내용에 걸쳐 검색
- 빠른 쿼리를 위한 FTS5 전문 검색
- 인용은 특정 관찰 내용으로 다시 연결

### 구조화된 관찰 내용

- AI 기반 학습 내용 추출
- 유형별 분류 (decision, bugfix, feature 등)
- 개념 및 파일 참조로 태그 지정

### 다중 프롬프트 세션

- 세션은 여러 사용자 프롬프트에 걸쳐 진행
- `/clear` 명령 간 컨텍스트 보존
- 전체 대화 스레드 추적

---

## 설정

설정은 `~/.claude-mem/settings.json`에서 관리됩니다. 파일은 첫 실행 시 기본값으로 자동 생성됩니다.

**사용 가능한 설정:**

| 설정 | 기본값 | 설명 |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | 관찰 내용용 AI 모델 |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | 워커 서비스 포트 |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | 데이터 디렉토리 위치 |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | 로그 상세 수준 (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | chroma-mcp용 Python 버전 |
| `CLAUDE_CODE_PATH` | _(자동 감지)_ | Claude 실행 파일 경로 |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | SessionStart 시 주입할 관찰 내용 수 |

**설정 관리:**

```bash
# CLI 헬퍼를 통한 설정 편집
./claude-mem-settings.sh

# 또는 직접 편집
nano ~/.claude-mem/settings.json

# 현재 설정 보기
curl http://localhost:37777/api/settings
```

**설정 파일 형식:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

자세한 내용은 [설정 가이드](https://docs.claude-mem.ai/configuration)를 참조하세요.

---

## 개발

```bash
# 복제 및 빌드
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# 테스트 실행
npm test

# 워커 시작
npm run worker:start

# 로그 보기
npm run worker:logs
```

자세한 지침은 [개발 가이드](https://docs.claude-mem.ai/development)를 참조하세요.

---

## 문제 해결

**빠른 진단:**

문제가 발생하면 Claude에게 문제를 설명하면 troubleshoot 스킬이 자동으로 활성화되어 진단하고 수정 방법을 제공합니다.

**일반적인 문제:**

- 워커가 시작되지 않음 → `npm run worker:restart`
- 컨텍스트가 나타나지 않음 → `npm run test:context`
- 데이터베이스 문제 → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- 검색이 작동하지 않음 → FTS5 테이블 존재 확인

전체 솔루션은 [문제 해결 가이드](https://docs.claude-mem.ai/troubleshooting)를 참조하세요.

---

## 기여

기여를 환영합니다! 다음을 수행해 주세요:

1. 저장소 포크
2. 기능 브랜치 생성
3. 테스트와 함께 변경 사항 작성
4. 문서 업데이트
5. Pull Request 제출

기여 워크플로는 [개발 가이드](https://docs.claude-mem.ai/development)를 참조하세요.

---

## 라이선스

이 프로젝트는 **GNU Affero General Public License v3.0** (AGPL-3.0)에 따라 라이선스가 부여됩니다.

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

전체 세부 정보는 [LICENSE](LICENSE) 파일을 참조하세요.

**의미:**

- 이 소프트웨어를 자유롭게 사용, 수정 및 배포할 수 있습니다
- 수정하여 네트워크 서버에 배포하는 경우 소스 코드를 제공해야 합니다
- 파생 저작물도 AGPL-3.0에 따라 라이선스가 부여되어야 합니다
- 이 소프트웨어에 대한 보증은 없습니다

---

## 지원

- **문서**: [docs/](docs/)
- **이슈**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **저장소**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **제작자**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Claude Agent SDK로 제작** | **Claude Code 기반** | **TypeScript로 제작**

---