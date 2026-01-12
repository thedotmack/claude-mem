🌐 이것은 자동 번역입니다. 커뮤니티의 수정 제안을 환영합니다!

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

<h4 align="center"><a href="https://claude.com/claude-code" target="_blank">Claude Code</a>를 위해 구축된 지속적인 메모리 압축 시스템.</h4>

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
  <a href="#빠른-시작">빠른 시작</a> •
  <a href="#작동-방식">작동 방식</a> •
  <a href="#mcp-검색-도구">검색 도구</a> •
  <a href="#문서">문서</a> •
  <a href="#설정">설정</a> •
  <a href="#문제-해결">문제 해결</a> •
  <a href="#라이선스">라이선스</a>
</p>

<p align="center">
  Claude-Mem은 도구 사용 관찰을 자동으로 캡처하고 의미론적 요약을 생성하여 향후 세션에서 사용할 수 있도록 함으로써 세션 간 컨텍스트를 원활하게 보존합니다. 이를 통해 Claude는 세션이 종료되거나 재연결된 후에도 프로젝트에 대한 지식의 연속성을 유지할 수 있습니다.
</p>

---

## 빠른 시작

터미널에서 새 Claude Code 세션을 시작하고 다음 명령을 입력하세요:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Claude Code를 재시작하세요. 이전 세션의 컨텍스트가 자동으로 새 세션에 나타납니다.

**주요 기능:**

- 🧠 **지속적인 메모리** - 세션 간 컨텍스트 유지
- 📊 **점진적 공개** - 토큰 비용 가시성을 갖춘 계층화된 메모리 검색
- 🔍 **스킬 기반 검색** - mem-search 스킬로 프로젝트 기록 쿼리
- 🖥️ **웹 뷰어 UI** - http://localhost:37777 에서 실시간 메모리 스트림 확인
- 💻 **Claude Desktop 스킬** - Claude Desktop 대화에서 메모리 검색
- 🔒 **개인정보 제어** - `<private>` 태그를 사용하여 민감한 콘텐츠를 저장소에서 제외
- ⚙️ **컨텍스트 설정** - 주입되는 컨텍스트에 대한 세밀한 제어
- 🤖 **자동 작동** - 수동 개입 불필요
- 🔗 **인용** - ID로 과거 관찰 참조 (http://localhost:37777/api/observation/{id} 를 통해 액세스하거나 http://localhost:37777 의 웹 뷰어에서 모두 보기)
- 🧪 **베타 채널** - 버전 전환을 통해 Endless Mode와 같은 실험적 기능 사용

---

## 문서

📚 **[전체 문서 보기](https://docs.claude-mem.ai/)** - 공식 웹사이트에서 찾아보기

### 시작하기

- **[설치 가이드](https://docs.claude-mem.ai/installation)** - 빠른 시작 및 고급 설치
- **[사용 가이드](https://docs.claude-mem.ai/usage/getting-started)** - Claude-Mem이 자동으로 작동하는 방법
- **[검색 도구](https://docs.claude-mem.ai/usage/search-tools)** - 자연어로 프로젝트 기록 쿼리
- **[베타 기능](https://docs.claude-mem.ai/beta-features)** - Endless Mode와 같은 실험적 기능 시도

### 모범 사례

- **[컨텍스트 엔지니어링](https://docs.claude-mem.ai/context-engineering)** - AI 에이전트 컨텍스트 최적화 원칙
- **[점진적 공개](https://docs.claude-mem.ai/progressive-disclosure)** - Claude-Mem의 컨텍스트 프라이밍 전략의 철학

### 아키텍처

- **[개요](https://docs.claude-mem.ai/architecture/overview)** - 시스템 구성 요소 및 데이터 흐름
- **[아키텍처 진화](https://docs.claude-mem.ai/architecture-evolution)** - v3에서 v5로의 여정
- **[후크 아키텍처](https://docs.claude-mem.ai/hooks-architecture)** - Claude-Mem이 라이프사이클 후크를 사용하는 방법
- **[후크 참조](https://docs.claude-mem.ai/architecture/hooks)** - 7개 후크 스크립트 설명
- **[워커 서비스](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API 및 Bun 관리
- **[데이터베이스](https://docs.claude-mem.ai/architecture/database)** - SQLite 스키마 및 FTS5 검색
- **[검색 아키텍처](https://docs.claude-mem.ai/architecture/search-architecture)** - Chroma 벡터 데이터베이스를 활용한 하이브리드 검색

### 설정 및 개발

- **[설정](https://docs.claude-mem.ai/configuration)** - 환경 변수 및 설정
- **[개발](https://docs.claude-mem.ai/development)** - 빌드, 테스트, 기여
- **[문제 해결](https://docs.claude-mem.ai/troubleshooting)** - 일반적인 문제 및 해결 방법

---

## 작동 방식

**핵심 구성 요소:**

1. **5개 라이프사이클 후크** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6개 후크 스크립트)
2. **스마트 설치** - 캐시된 종속성 검사기 (사전 후크 스크립트, 라이프사이클 후크 아님)
3. **워커 서비스** - 웹 뷰어 UI와 10개 검색 엔드포인트를 갖춘 포트 37777의 HTTP API, Bun으로 관리
4. **SQLite 데이터베이스** - 세션, 관찰, 요약 저장
5. **mem-search 스킬** - 점진적 공개를 통한 자연어 쿼리
6. **Chroma 벡터 데이터베이스** - 지능형 컨텍스트 검색을 위한 하이브리드 의미론적 + 키워드 검색

자세한 내용은 [아키텍처 개요](https://docs.claude-mem.ai/architecture/overview)를 참조하세요.

---

## mem-search 스킬

Claude-Mem은 과거 작업에 대해 질문할 때 자동으로 호출되는 mem-search 스킬을 통해 지능형 검색을 제공합니다:

**작동 방식:**
- 자연스럽게 질문하세요: *"지난 세션에서 무엇을 했나요?"* 또는 *"이 버그를 이전에 수정했나요?"*
- Claude가 관련 컨텍스트를 찾기 위해 mem-search 스킬을 자동으로 호출합니다

**사용 가능한 검색 작업:**

1. **관찰 검색** - 관찰에 대한 전체 텍스트 검색
2. **세션 검색** - 세션 요약에 대한 전체 텍스트 검색
3. **프롬프트 검색** - 원시 사용자 요청 검색
4. **개념별** - 개념 태그로 찾기 (discovery, problem-solution, pattern 등)
5. **파일별** - 특정 파일을 참조하는 관찰 찾기
6. **유형별** - 유형별로 찾기 (decision, bugfix, feature, refactor, discovery, change)
7. **최근 컨텍스트** - 프로젝트의 최근 세션 컨텍스트 가져오기
8. **타임라인** - 특정 시점 주변의 통합된 컨텍스트 타임라인 가져오기
9. **쿼리별 타임라인** - 관찰을 검색하고 가장 일치하는 항목 주변의 타임라인 컨텍스트 가져오기
10. **API 도움말** - 검색 API 문서 가져오기

**자연어 쿼리 예제:**

```
"지난 세션에서 어떤 버그를 수정했나요?"
"인증을 어떻게 구현했나요?"
"worker-service.ts에 어떤 변경 사항이 있었나요?"
"이 프로젝트의 최근 작업을 보여주세요"
"뷰어 UI를 추가할 때 무슨 일이 있었나요?"
```

자세한 예제는 [검색 도구 가이드](https://docs.claude-mem.ai/usage/search-tools)를 참조하세요.

---

## 베타 기능

Claude-Mem은 **Endless Mode**(확장된 세션을 위한 생체모방 메모리 아키텍처)와 같은 실험적 기능을 제공하는 **베타 채널**을 제공합니다. http://localhost:37777 → Settings의 웹 뷰어 UI에서 안정 버전과 베타 버전 간 전환이 가능합니다.

Endless Mode 및 사용 방법에 대한 자세한 내용은 **[베타 기능 문서](https://docs.claude-mem.ai/beta-features)**를 참조하세요.

---

## 시스템 요구 사항

- **Node.js**: 18.0.0 이상
- **Claude Code**: 플러그인 지원이 있는 최신 버전
- **Bun**: JavaScript 런타임 및 프로세스 관리자 (누락 시 자동 설치)
- **uv**: 벡터 검색을 위한 Python 패키지 관리자 (누락 시 자동 설치)
- **SQLite 3**: 영구 저장을 위한 데이터베이스 (번들 포함)

---

## 설정

설정은 `~/.claude-mem/settings.json`에서 관리됩니다 (첫 실행 시 기본값으로 자동 생성). AI 모델, 워커 포트, 데이터 디렉토리, 로그 수준 및 컨텍스트 주입 설정을 구성할 수 있습니다.

사용 가능한 모든 설정 및 예제는 **[설정 가이드](https://docs.claude-mem.ai/configuration)**를 참조하세요.

---

## 개발

빌드 지침, 테스트 및 기여 워크플로우는 **[개발 가이드](https://docs.claude-mem.ai/development)**를 참조하세요.

---

## 문제 해결

문제가 발생하면 Claude에게 문제를 설명하면 troubleshoot 스킬이 자동으로 진단하고 수정 사항을 제공합니다.

일반적인 문제 및 해결 방법은 **[문제 해결 가이드](https://docs.claude-mem.ai/troubleshooting)**를 참조하세요.

---

## 버그 보고

자동화된 생성기로 포괄적인 버그 보고서를 작성하세요:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## 기여

기여를 환영합니다! 다음 절차를 따라주세요:

1. 저장소 포크
2. 기능 브랜치 생성
3. 테스트와 함께 변경 사항 작성
4. 문서 업데이트
5. Pull Request 제출

기여 워크플로우는 [개발 가이드](https://docs.claude-mem.ai/development)를 참조하세요.

---

## 라이선스

이 프로젝트는 **GNU Affero General Public License v3.0** (AGPL-3.0)에 따라 라이선스가 부여됩니다.

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

전체 세부 정보는 [LICENSE](LICENSE) 파일을 참조하세요.

**의미:**

- 이 소프트웨어를 자유롭게 사용, 수정 및 배포할 수 있습니다
- 수정하여 네트워크 서버에 배포하는 경우 소스 코드를 공개해야 합니다
- 파생 작업물도 AGPL-3.0에 따라 라이선스가 부여되어야 합니다
- 이 소프트웨어에는 보증이 없습니다

**Ragtime에 대한 참고 사항**: `ragtime/` 디렉토리는 **PolyForm Noncommercial License 1.0.0**에 따라 별도로 라이선스가 부여됩니다. 자세한 내용은 [ragtime/LICENSE](ragtime/LICENSE)를 참조하세요.

---

## 지원

- **문서**: [docs/](docs/)
- **이슈**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **저장소**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **작성자**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Claude Agent SDK로 구축** | **Claude Code 기반** | **TypeScript로 제작**

---