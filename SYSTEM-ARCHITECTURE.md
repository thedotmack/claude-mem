# System Arkitektur — claude-mem i NORTHSTAR-platformen

**Version 1.0 — 5. april 2026**

> Detaljeret arkitektur for claude-mem og dens rolle i NORTHSTAR Forensic Platform.

---

## Overblik

claude-mem er et Claude Code plugin der giver persistent hukommelse på tværs af sessioner. I konteksten af NORTHSTAR Forensic Platform fungerer det som det **lokale hukommelseslag** — det fanger tool-brug, komprimerer kontekst via Claude Agent SDK, og injicerer relevant viden i fremtidige sessioner.

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code Session                       │
│                                                             │
│  SessionStart ──► UserPromptSubmit ──► PostToolUse          │
│       │                                     │               │
│       │              ┌──────────────┐       │               │
│       └──────────────│ Worker Svc   │◄──────┘               │
│     (kontekst in)    │ :37777       │  (observationer ud)   │
│                      └──────┬───────┘                       │
│                             │                               │
│                    ┌────────┴────────┐                      │
│                    │                 │                      │
│               ┌────▼─────┐   ┌──────▼──────┐              │
│               │ SQLite   │   │   Chroma    │              │
│               │ FTS5     │   │   Vectors   │              │
│               └──────────┘   └─────────────┘              │
└─────────────────────────────────────────────────────────────┘
```

### Rolle i platformen

| Repository | Hukommelsestype | Varighed | Søgning |
|------------|-----------------|----------|---------|
| **claude-mem** | Ustruktureret observationer, komprimeret kontekst | Permanent (lokal) | FTS5 + Chroma semantisk |
| `northstar-memory-mcp-server` | Struktureret fakta, opgaver, tidslinje | Permanent (cloud) | PostgreSQL FTS (dansk) |
| `northstar-tools` | Analyse-skills og agents | Session-baseret | — |
| `EWR-Investigation` | Bevisfiler og chain of custody | Permanent (lokal) | SQLite evidence.db |

---

## Komponentarkitektur

### Lifecycle Hooks (5 faser)

```
SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd
```

| Hook | Kilde | Funktion |
|------|-------|----------|
| **SessionStart** | `src/hooks/session-start.ts` | Indlæser relevant kontekst fra SQLite + Chroma |
| **UserPromptSubmit** | `src/hooks/user-prompt-submit.ts` | Beriger bruger-prompts med historisk kontekst |
| **PostToolUse** | `src/hooks/post-tool-use.ts` | Fanger observationer fra tool-brug |
| **Summary** | `src/hooks/summary.ts` | Komprimerer sessionsdata via Claude Agent SDK |
| **SessionEnd** | `src/hooks/session-end.ts` | Persisterer sessionsoversigt |

### Worker Service

| Egenskab | Værdi |
|----------|-------|
| Port | 37777 |
| Framework | Express.js |
| Process manager | Bun |
| API | HTTP REST |
| UI | React viewer (`/`) |

### Storage

| Komponent | Placering | Formål |
|-----------|-----------|--------|
| SQLite | `~/.claude-mem/claude-mem.db` | Observationer, sessioner, komprimeret kontekst |
| Chroma | `~/.claude-mem/chroma/` | Vektorembeddings til semantisk søgning |
| Settings | `~/.claude-mem/settings.json` | Konfiguration (auto-oprettet) |

### Skills

| Skill | Funktion |
|-------|----------|
| `mem-search` | Naturligt sprogsøgning i historik via HTTP API |
| `make-plan` | Faseopdelt implementeringsplanlægning |
| `do` | Faseudførelse med subagents |

---

## Dataflow

### Observation → Komprimering → Injektion

```
PostToolUse hook
    │
    ├── Fanger tool-navn, input, output-observationer
    ├── Stripper <private> tags (edge processing)
    │
    ▼
Worker Service (:37777)
    │
    ├── Gemmer rå observation i SQLite
    ├── Synkroniserer embedding til Chroma
    │
    ▼
Summary hook (periodisk)
    │
    ├── Henter ubehandlede observationer
    ├── Komprimerer via Claude Agent SDK
    ├── Gemmer komprimeret kontekst
    │
    ▼
SessionStart hook (næste session)
    │
    ├── Henter relevante kontekst-fragmenter
    ├── Progressive disclosure med token-cost synlighed
    └── Injicerer i Claude Code session
```

### Samspil med MCP-serveren

```
claude-mem fanger:           MCP-serveren lagrer:
─────────────────           ────────────────────
• Tool-brug observationer   • Eksplicitte fakta (ns_fact_store)
• Implicitte mønstre        • Opgaver (ns_task_create)
• Session-komprimering      • Tidslinje (ns_timeline_add)
• Kode-kontekst             • Session-handoffs (ns_session_save)
```

De to systemer er **komplementære**: claude-mem fanger det implicitte, MCP-serveren det eksplicitte.

---

## Kildestruktur

```
src/
├── bin/                  ← CLI binaries
├── cli/                  ← Command-line interface + adapters
├── hooks/                ← 5 lifecycle hooks (→ plugin/scripts/)
├── sdk/                  ← SDK og integration
├── servers/              ← Server-implementeringer
├── services/
│   ├── Context.ts        ← Kontekststyring
│   ├── context/          ← Kontekstdomæne
│   ├── domain/           ← Forretningslogik
│   ├── infrastructure/   ← Infrastruktur-lag
│   ├── integrations/     ← Tredjepartsintegrationer
│   ├── queue/            ← Opgavekø
│   ├── server/           ← HTTP server
│   ├── smart-file-read/  ← Intelligent fillæsning
│   ├── sqlite/           ← Database-lag
│   ├── sync/             ← Chroma vektorsync
│   ├── transcripts/      ← Transskriptionshåndtering
│   ├── worker/           ← Worker-logik
│   └── worker-service.ts ← Hoved-worker
├── supervisor/           ← Orkestrering
├── types/                ← TypeScript typer
├── ui/viewer/            ← React web viewer
└── utils/
    └── tag-stripping.ts  ← Privacy tag-håndtering
```

### Build-pipeline

```
TypeScript (src/) → esbuild → plugin/scripts/*-hook.js
                             → plugin/ui/viewer.html
```

**Installeret plugin:** `~/.claude/plugins/marketplaces/thedotmack/`

---

## Sikkerhed

| Lag | Implementering |
|-----|----------------|
| Privacy | `<private>` tags strippet ved hook-lag inden data når worker |
| Transport | Kun localhost (:37777) — ingen ekstern adgang |
| Storage | Lokal SQLite + Chroma — ingen cloud-dependency |
| Exit codes | 0 = success, 1 = non-blocking error, 2 = blocking error |

---

## Teknologistak

| Komponent | Version/Teknologi |
|-----------|-------------------|
| Runtime | Node.js 18+, Bun (process manager) |
| Sprog | TypeScript (ESM) |
| AI | Claude Agent SDK |
| MCP | `@modelcontextprotocol/sdk` |
| HTTP | Express.js |
| Database | SQLite3 med FTS5 |
| Vektorsøgning | Chroma |
| UI | React |
| Build | esbuild + tsc |
| Test | Bun test framework |

---

## Monitorering

| Hvad | Hvor |
|------|------|
| Worker health | `http://localhost:37777` |
| Session-historik | Viewer UI (`http://localhost:37777`) |
| Database-størrelse | `~/.claude-mem/claude-mem.db` |
| Chroma-status | `~/.claude-mem/chroma/` |

---

*v1.0 — Oprettet 2026-04-05 som del af systemarkitektur-dokumentation*
*Se også: `CLAUDE.md`, `docs/public/architecture/`*
