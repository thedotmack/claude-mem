src
├── bin
│   ├── cleanup-duplicates.ts
│   └── import-xml-observations.ts
├── hooks
│   ├── cleanup-hook.ts
│   ├── context-hook.ts
│   ├── hook-response.ts
│   ├── index.ts
│   ├── new-hook.ts
│   ├── save-hook.ts
│   ├── summary-hook.ts
│   └── user-message-hook.ts
├── sdk
│   ├── index.ts
│   ├── parser.test.ts
│   ├── parser.ts
│   └── prompts.ts
├── servers
│   └── search-server.ts
├── services
│   ├── sqlite
│   │   ├── Database.ts
│   │   ├── SessionSearch.ts
│   │   ├── SessionStore.ts
│   │   ├── index.ts
│   │   ├── migrations.ts
│   │   └── types.ts
│   ├── sync
│   │   └── ChromaSync.ts
│   └── worker-service.ts
├── shared
│   ├── config.ts
│   ├── paths.ts
│   ├── storage.ts
│   ├── types.ts
│   └── worker-utils.ts
├── ui
│   ├── claude-mem-logo-for-dark-mode.webp
│   ├── claude-mem-logomark.webp
│   ├── viewer
│   │   ├── App.tsx
│   │   ├── assets
│   │   │   └── fonts
│   │   │       ├── monaspace-radon-var.woff
│   │   │       └── monaspace-radon-var.woff2
│   │   ├── components
│   │   │   ├── ErrorBoundary.tsx
│   │   │   ├── Feed.tsx
│   │   │   ├── Header.tsx
│   │   │   ├── ObservationCard.tsx
│   │   │   ├── PromptCard.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   ├── SummaryCard.tsx
│   │   │   └── ThemeToggle.tsx
│   │   ├── constants
│   │   │   ├── api.ts
│   │   │   ├── settings.ts
│   │   │   ├── timing.ts
│   │   │   └── ui.ts
│   │   ├── hooks
│   │   │   ├── usePagination.ts
│   │   │   ├── useSSE.ts
│   │   │   ├── useSettings.ts
│   │   │   ├── useStats.ts
│   │   │   └── useTheme.ts
│   │   ├── index.tsx
│   │   ├── types.ts
│   │   └── utils
│   │       ├── data.ts
│   │       └── formatters.ts
│   └── viewer-template.html
└── utils
    ├── logger.ts
    ├── platform.ts
    └── usage-logger.ts

18 directories, 58 files
