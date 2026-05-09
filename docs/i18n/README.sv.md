🌐 Detta är en automatiserad översättning. Bidrag från gemenskapen är välkomna!

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

<h4 align="center">Persistent minneskomprimeringsystem byggt för <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" alt="License">
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
  <a href="#snabbstart">Snabbstart</a> •
  <a href="#hur-det-fungerar">Hur det fungerar</a> •
  <a href="#sökverktyg-mcp">Sökverktyg</a> •
  <a href="#dokumentation">Dokumentation</a> •
  <a href="#konfiguration">Konfiguration</a> •
  <a href="#felsökning">Felsökning</a> •
  <a href="#licens">Licens</a>
</p>

<p align="center">
  Claude-Mem bevarar sömlöst kontext mellan sessioner genom att automatiskt fånga observationer av verktygsanvändning, generera semantiska sammanfattningar och göra dem tillgängliga för framtida sessioner. Detta gör det möjligt för Claude att upprätthålla kontinuitet i kunskap om projekt även efter att sessioner avslutas eller återansluter.
</p>

---

## Snabbstart

Starta en ny Claude Code-session i terminalen och ange följande kommandon:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Starta om Claude Code. Kontext från tidigare sessioner kommer automatiskt att visas i nya sessioner.

**Nyckelfunktioner:**

- 🧠 **Persistent minne** - Kontext överlever mellan sessioner
- 📊 **Progressiv visning** - Skiktad minneshämtning med synlighet för tokenkostnad
- 🔍 **Färdighetsbaserad sökning** - Sök i din projekthistorik med mem-search-färdigheten
- 🖥️ **Webbvy-gränssnitt** - Realtidsminnesström på http://localhost:37777
- 💻 **Claude Desktop-färdighet** - Sök i minnet från Claude Desktop-konversationer
- 🔒 **Integritetskontroll** - Använd `<private>`-taggar för att exkludera känsligt innehåll från lagring
- ⚙️ **Kontextkonfiguration** - Detaljerad kontroll över vilken kontext som injiceras
- 🤖 **Automatisk drift** - Ingen manuell hantering krävs
- 🔗 **Citeringar** - Referera till tidigare observationer med ID:n (tillgängliga via http://localhost:37777/api/observation/{id} eller visa alla i webbvyn på http://localhost:37777)
- 🧪 **Betakanal** - Testa experimentella funktioner som Endless Mode via versionsväxling

---

## Dokumentation

📚 **[Visa fullständig dokumentation](https://docs.claude-mem.ai/)** - Bläddra på den officiella webbplatsen

### Komma igång

- **[Installationsguide](https://docs.claude-mem.ai/installation)** - Snabbstart och avancerad installation
- **[Användarguide](https://docs.claude-mem.ai/usage/getting-started)** - Hur Claude-Mem fungerar automatiskt
- **[Sökverktyg](https://docs.claude-mem.ai/usage/search-tools)** - Sök i din projekthistorik med naturligt språk
- **[Betafunktioner](https://docs.claude-mem.ai/beta-features)** - Testa experimentella funktioner som Endless Mode

### Bästa praxis

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - Optimeringsmetoder för AI-agentkontext
- **[Progressiv visning](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofin bakom Claude-Mems kontextpriming-strategi

### Arkitektur

- **[Översikt](https://docs.claude-mem.ai/architecture/overview)** - Systemkomponenter och dataflöde
- **[Arkitekturutveckling](https://docs.claude-mem.ai/architecture-evolution)** - Resan från v3 till v5
- **[Hooks-arkitektur](https://docs.claude-mem.ai/hooks-architecture)** - Hur Claude-Mem använder livscykelkrokar
- **[Hooks-referens](https://docs.claude-mem.ai/architecture/hooks)** - 7 hook-skript förklarade
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API och Bun-hantering
- **[Databas](https://docs.claude-mem.ai/architecture/database)** - SQLite-schema och FTS5-sökning
- **[Sökarkitektur](https://docs.claude-mem.ai/architecture/search-architecture)** - Hybridsökning med Chroma-vektordatabas

### Konfiguration och utveckling

- **[Konfiguration](https://docs.claude-mem.ai/configuration)** - Miljövariabler och inställningar
- **[Utveckling](https://docs.claude-mem.ai/development)** - Bygga, testa, bidra
- **[Felsökning](https://docs.claude-mem.ai/troubleshooting)** - Vanliga problem och lösningar

---

## Hur det fungerar

**Kärnkomponenter:**

1. **5 livscykelkrokar** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook-skript)
2. **Smart installation** - Cachad beroendekontrollant (pre-hook-skript, inte en livscykelkrok)
3. **Worker Service** - HTTP API på port 37777 med webbvy-gränssnitt och 10 sökändpunkter, hanterat av Bun
4. **SQLite-databas** - Lagrar sessioner, observationer, sammanfattningar
5. **mem-search-färdighet** - Naturligspråkssökningar med progressiv visning
6. **Chroma-vektordatabas** - Hybrid semantisk + nyckelordssökning för intelligent kontexthämtning

Se [Arkitekturöversikt](https://docs.claude-mem.ai/architecture/overview) för detaljer.

---

## mem-search-färdighet

Claude-Mem tillhandahåller intelligent sökning genom mem-search-färdigheten som automatiskt aktiveras när du frågar om tidigare arbete:

**Hur det fungerar:**
- Fråga bara naturligt: *"Vad gjorde vi förra sessionen?"* eller *"Fixade vi den här buggen tidigare?"*
- Claude aktiverar automatiskt mem-search-färdigheten för att hitta relevant kontext

**Tillgängliga sökoperationer:**

1. **Search Observations** - Fulltextsökning över observationer
2. **Search Sessions** - Fulltextsökning över sessionssammanfattningar
3. **Search Prompts** - Sök i råa användarförfrågningar
4. **By Concept** - Hitta efter koncepttaggar (discovery, problem-solution, pattern, etc.)
5. **By File** - Hitta observationer som refererar till specifika filer
6. **By Type** - Hitta efter typ (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Hämta senaste sessionskontext för ett projekt
8. **Timeline** - Få en enhetlig tidslinje av kontext kring en specifik tidpunkt
9. **Timeline by Query** - Sök efter observationer och få tidslinjekontext kring bästa matchning
10. **API Help** - Få API-dokumentation för sökning

**Exempel på naturligspråkssökningar:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

Se [Sökverktygsguide](https://docs.claude-mem.ai/usage/search-tools) för detaljerade exempel.

---

## Betafunktioner

Claude-Mem erbjuder en **betakanal** med experimentella funktioner som **Endless Mode** (biomimetisk minnesarkitektur för utökade sessioner). Växla mellan stabila och betaversioner från webbvy-gränssnittet på http://localhost:37777 → Settings.

Se **[Dokumentation för betafunktioner](https://docs.claude-mem.ai/beta-features)** för detaljer om Endless Mode och hur du testar det.

---

## Systemkrav

- **Node.js**: 18.0.0 eller högre
- **Claude Code**: Senaste versionen med plugin-stöd
- **Bun**: JavaScript-runtime och processhanterare (installeras automatiskt om den saknas)
- **uv**: Python-pakethanterare för vektorsökning (installeras automatiskt om den saknas)
- **SQLite 3**: För persistent lagring (ingår)

---

## Konfiguration

Inställningar hanteras i `~/.claude-mem/settings.json` (skapas automatiskt med standardvärden vid första körning). Konfigurera AI-modell, worker-port, datakatalog, loggnivå och kontextinjektionsinställningar.

Se **[Konfigurationsguide](https://docs.claude-mem.ai/configuration)** för alla tillgängliga inställningar och exempel.

---

## Utveckling

Se **[Utvecklingsguide](https://docs.claude-mem.ai/development)** för bygginstruktioner, testning och bidragsarbetsflöde.

---

## Felsökning

Om du upplever problem, beskriv problemet för Claude och felsökningsfärdigheten kommer automatiskt att diagnostisera och tillhandahålla lösningar.

Se **[Felsökningsguide](https://docs.claude-mem.ai/troubleshooting)** för vanliga problem och lösningar.

---

## Buggrapporter

Skapa omfattande buggrapporter med den automatiserade generatorn:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Bidrag

Bidrag är välkomna! Vänligen:

1. Forka repositoryt
2. Skapa en feature-gren
3. Gör dina ändringar med tester
4. Uppdatera dokumentationen
5. Skicka in en Pull Request

Se [Utvecklingsguide](https://docs.claude-mem.ai/development) för bidragsarbetsflöde.

---

## License

This project is licensed under the **Apache License 2.0** (Apache-2.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

Apache-2.0 allows broad use, modification, distribution, and commercial use, subject to its terms.

**Ragtime note**: The ragtime/ directory is licensed under the **Apache License 2.0**. See [ragtime/LICENSE](ragtime/LICENSE) for details.

---


## Support

- **Dokumentation**: [docs/](docs/)
- **Problem**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Författare**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Byggd med Claude Agent SDK** | **Drivs av Claude Code** | **Skapad med TypeScript**