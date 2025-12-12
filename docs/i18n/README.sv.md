🌐 Detta är en automatisk översättning. Gemenskapens korrigeringar är välkomna!

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

<h4 align="center">Beständigt minneskomprimeringsystem byggt för <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#snabbstart">Snabbstart</a> •
  <a href="#hur-det-fungerar">Hur Det Fungerar</a> •
  <a href="#sökverktyg">Sökverktyg</a> •
  <a href="#dokumentation">Dokumentation</a> •
  <a href="#konfiguration">Konfiguration</a> •
  <a href="#felsökning">Felsökning</a> •
  <a href="#licens">Licens</a>
</p>

<p align="center">
  Claude-Mem bevarar sömlöst sammanhang mellan sessioner genom att automatiskt fånga observationer från verktygsanvändning, generera semantiska sammanfattningar och göra dem tillgängliga för framtida sessioner. Detta gör det möjligt för Claude att upprätthålla kontinuitet i kunskap om projekt även efter att sessioner avslutas eller återansluts.
</p>

---

## Snabbstart

Starta en ny Claude Code-session i terminalen och ange följande kommandon:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Starta om Claude Code. Sammanhang från tidigare sessioner kommer automatiskt att visas i nya sessioner.

**Nyckelfunktioner:**

- 🧠 **Beständigt Minne** - Sammanhang överlever mellan sessioner
- 📊 **Progressiv Avslöjande** - Skiktad minneshämtning med synlighet för token-kostnad
- 🔍 **Färdighetsbaserad Sökning** - Fråga din projekthistorik med mem-search färdighet (~2 250 token-besparing)
- 🖥️ **Webb-baserat Gränssnitt** - Minnesström i realtid på http://localhost:37777
- 🔒 **Integritetskontroll** - Använd `<private>`-taggar för att utesluta känsligt innehåll från lagring
- ⚙️ **Kontextkonfiguration** - Finkornig kontroll över vilket sammanhang som injiceras
- 🤖 **Automatisk Drift** - Ingen manuell åtgärd krävs
- 🔗 **Citeringar** - Referera till tidigare beslut med `claude-mem://` URI:er
- 🧪 **Beta-kanal** - Prova experimentella funktioner som Endless Mode genom versionsväxling

---

## Dokumentation

📚 **[Visa Fullständig Dokumentation](docs/)** - Bläddra i markdown-dokument på GitHub

💻 **Lokal Förhandsgranskning**: Kör Mintlify-dokument lokalt:

```bash
cd docs
npx mintlify dev
```

### Komma Igång

- **[Installationsguide](https://docs.claude-mem.ai/installation)** - Snabbstart & avancerad installation
- **[Användarguide](https://docs.claude-mem.ai/usage/getting-started)** - Hur Claude-Mem fungerar automatiskt
- **[Sökverktyg](https://docs.claude-mem.ai/usage/search-tools)** - Fråga din projekthistorik med naturligt språk
- **[Beta-funktioner](https://docs.claude-mem.ai/beta-features)** - Prova experimentella funktioner som Endless Mode

### Bästa Praxis

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - Principer för AI-agentens kontextoptimering
- **[Progressiv Avslöjande](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofi bakom Claude-Mems kontextförberedelsestrategi

### Arkitektur

- **[Översikt](https://docs.claude-mem.ai/architecture/overview)** - Systemkomponenter & dataflöde
- **[Arkitekturutveckling](https://docs.claude-mem.ai/architecture-evolution)** - Resan från v3 till v5
- **[Hooks-arkitektur](https://docs.claude-mem.ai/hooks-architecture)** - Hur Claude-Mem använder livscykel-hooks
- **[Hooks-referens](https://docs.claude-mem.ai/architecture/hooks)** - 7 hook-skript förklarade
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API & PM2-hantering
- **[Databas](https://docs.claude-mem.ai/architecture/database)** - SQLite-schema & FTS5-sökning
- **[Sökarkitektur](https://docs.claude-mem.ai/architecture/search-architecture)** - Hybridsökning med Chroma vektordatabas

### Konfiguration & Utveckling

- **[Konfiguration](https://docs.claude-mem.ai/configuration)** - Miljövariabler & inställningar
- **[Utveckling](https://docs.claude-mem.ai/development)** - Bygga, testa, bidra
- **[Felsökning](https://docs.claude-mem.ai/troubleshooting)** - Vanliga problem & lösningar

---

## Hur Det Fungerar

```
┌─────────────────────────────────────────────────────────────┐
│ Sessionstart → Injicera senaste observationer som kontext  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Användarförfrågningar → Skapa session, spara förfrågningar │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Verktygsexekveringar → Fånga observationer (Read, Write etc)│
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Worker-processer → Extrahera lärdomar via Claude Agent SDK  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Sessionslut → Generera sammanfattning, klar för nästa session│
└─────────────────────────────────────────────────────────────┘
```

**Kärnkomponenter:**

1. **5 Livscykel-Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook-skript)
2. **Smart Installation** - Cachad beroendekontrollen (pre-hook-skript, inte en livscykel-hook)
3. **Worker Service** - HTTP API på port 37777 med webb-baserat gränssnitt och 10 sökändpunkter, hanterat av PM2
4. **SQLite-databas** - Lagrar sessioner, observationer, sammanfattningar med FTS5 fulltextsökning
5. **mem-search Färdighet** - Naturliga språkfrågor med progressiv avslöjande (~2 250 token-besparing vs MCP)
6. **Chroma Vektordatabas** - Hybrid semantisk + nyckelordssökning för intelligent kontexthämtning

Se [Arkitekturöversikt](https://docs.claude-mem.ai/architecture/overview) för detaljer.

---

## mem-search Färdighet

Claude-Mem tillhandahåller intelligent sökning genom mem-search färdigheten som automatiskt aktiveras när du frågar om tidigare arbete:

**Hur Det Fungerar:**
- Fråga bara naturligt: *"Vad gjorde vi förra sessionen?"* eller *"Har vi fixat det här felet tidigare?"*
- Claude aktiverar automatiskt mem-search färdigheten för att hitta relevant sammanhang
- ~2 250 token-besparing per sessionstart jämfört med MCP-metoden

**Tillgängliga Sökoperationer:**

1. **Sök Observationer** - Fulltextsökning över observationer
2. **Sök Sessioner** - Fulltextsökning över sessionssammanfattningar
3. **Sök Förfrågningar** - Sök råa användarförfrågningar
4. **Efter Koncept** - Hitta efter koncepttaggar (discovery, problem-solution, pattern, etc.)
5. **Efter Fil** - Hitta observationer som refererar till specifika filer
6. **Efter Typ** - Hitta efter typ (decision, bugfix, feature, refactor, discovery, change)
7. **Senaste Sammanhang** - Få senaste sessionssammanhang för ett projekt
8. **Tidslinje** - Få en enhetlig tidslinje av sammanhang kring en specifik tidpunkt
9. **Tidslinje efter Fråga** - Sök efter observationer och få tidslinje-sammanhang kring bästa matchning
10. **API-hjälp** - Få sök-API-dokumentation

**Exempel på Naturliga Språkfrågor:**

```
"Vilka buggar fixade vi förra sessionen?"
"Hur implementerade vi autentisering?"
"Vilka ändringar gjordes i worker-service.ts?"
"Visa mig senaste arbetet på det här projektet"
"Vad hände när vi lade till visningsgränssnittet?"
```

Se [Sökverktygsguide](https://docs.claude-mem.ai/usage/search-tools) för detaljerade exempel.

---

## Beta-funktioner & Endless Mode

Claude-Mem erbjuder en **beta-kanal** med experimentella funktioner. Växla mellan stabila och beta-versioner direkt från webb-gränssnittet.

### Hur Man Provar Beta

1. Öppna http://localhost:37777
2. Klicka på Inställningar (kugghjulsikonen)
3. I **Version Channel**, klicka "Try Beta (Endless Mode)"
4. Vänta på att worker startar om

Din minnesdata bevaras vid versionsväxling.

### Endless Mode (Beta)

Flaggskeppet bland beta-funktionerna är **Endless Mode** - en biomimetisk minnesarkitektur som dramatiskt förlänger sessionslängden:

**Problemet**: Standard Claude Code-sessioner når kontextgränser efter ~50 verktygsanvändningar. Varje verktyg lägger till 1-10k+ tokens, och Claude syntetiserar om alla tidigare utdata vid varje svar (O(N²) komplexitet).

**Lösningen**: Endless Mode komprimerar verktygsutdata till ~500-token observationer och transformerar transkriptet i realtid:

```
Arbetsminne (Kontext):      Komprimerade observationer (~500 tokens vardera)
Arkivminne (Disk):          Fullständiga verktygsutdata bevarade för återsökning
```

**Förväntade Resultat**:
- ~95% token-reduktion i kontextfönster
- ~20x fler verktygsanvändningar innan kontextutmattning
- Linjär O(N) skalning istället för kvadratisk O(N²)
- Fullständiga transkript bevarade för perfekt återsökning

**Förbehåll**: Tillför latens (60-90s per verktyg för observationsgenerering), fortfarande experimentellt.

Se [Beta-funktionsdokumentation](https://docs.claude-mem.ai/beta-features) för detaljer.

---

## Vad Som Är Nytt

**v6.4.9 - Inställningar för Kontextkonfiguration:**
- 11 nya inställningar för finkornig kontroll över kontextinjicering
- Konfigurera visning av token-ekonomi, observationsfiltrering efter typ/koncept
- Kontrollera antal observationer och vilka fält som ska visas

**v6.4.0 - Dubbel-tagg Integritetssystem:**
- `<private>`-taggar för användarstyrd integritet - omslagningskänsligt innehåll för att utesluta från lagring
- Systemnivå `<claude-mem-context>`-taggar förhindrar rekursiv observationslagring
- Edge-bearbetning säkerställer att privat innehåll aldrig når databasen

**v6.3.0 - Versionskanal:**
- Växla mellan stabila och beta-versioner från webb-gränssnittet
- Prova experimentella funktioner som Endless Mode utan manuella git-operationer

**Tidigare Höjdpunkter:**
- **v6.0.0**: Stora förbättringar av sessionshantering & transkriptbearbetning
- **v5.5.0**: Förbättring av mem-search färdighet med 100% effektivitetsgrad
- **v5.4.0**: Färdighetsbaserad sökarkitektur (~2 250 tokens sparade per session)
- **v5.1.0**: Webb-baserat visningsgränssnitt med uppdateringar i realtid
- **v5.0.0**: Hybridsökning med Chroma vektordatabas

Se [CHANGELOG.md](CHANGELOG.md) för fullständig versionshistorik.

---

## Systemkrav

- **Node.js**: 18.0.0 eller högre
- **Claude Code**: Senaste versionen med plugin-stöd
- **PM2**: Processhanterare (medföljande - ingen global installation krävs)
- **SQLite 3**: För beständig lagring (medföljande)

---

## Viktiga Fördelar

### Progressiv Avslöjande Kontext

- **Skiktad minneshämtning** speglar mänskliga minnesmönster
- **Lager 1 (Index)**: Se vilka observationer som finns med token-kostnader vid sessionstart
- **Lager 2 (Detaljer)**: Hämta fullständiga berättelser på begäran via MCP-sökning
- **Lager 3 (Perfekt Återsökning)**: Åtkomst till källkod och ursprungliga transkript
- **Smart beslutsfattande**: Token-antal hjälper Claude att välja mellan att hämta detaljer eller läsa kod
- **Typindikatorer**: Visuella ledtrådar (🔴 kritisk, 🟤 beslut, 🔵 informativ) lyfter fram observationens betydelse

### Automatiskt Minne

- Sammanhang injiceras automatiskt när Claude startar
- Inga manuella kommandon eller konfiguration behövs
- Fungerar transparent i bakgrunden

### Fullständig Historiksökning

- Sök över alla sessioner och observationer
- FTS5 fulltextsökning för snabba frågor
- Citeringar länkar tillbaka till specifika observationer

### Strukturerade Observationer

- AI-driven extrahering av lärdomar
- Kategoriserad efter typ (decision, bugfix, feature, etc.)
- Taggad med koncept och filreferenser

### Sessioner med Flera Förfrågningar

- Sessioner sträcker sig över flera användarförfrågningar
- Sammanhang bevaras över `/clear`-kommandon
- Spåra hela konversationstrådar

---

## Konfiguration

Inställningar hanteras i `~/.claude-mem/settings.json`. Filen skapas automatiskt med standardvärden vid första körningen.

**Tillgängliga Inställningar:**

| Inställning | Standard | Beskrivning |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | AI-modell för observationer |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | Worker service-port |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | Datakatalogplats |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | Loggnivå (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | Python-version för chroma-mcp |
| `CLAUDE_CODE_PATH` | _(auto-detektering)_ | Sökväg till Claude-körbar fil |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Antal observationer att injicera vid SessionStart |

**Inställningshantering:**

```bash
# Redigera inställningar via CLI-hjälpare
./claude-mem-settings.sh

# Eller redigera direkt
nano ~/.claude-mem/settings.json

# Visa aktuella inställningar
curl http://localhost:37777/api/settings
```

**Inställningsfilformat:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

Se [Konfigurationsguide](https://docs.claude-mem.ai/configuration) för detaljer.

---

## Utveckling

```bash
# Klona och bygg
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# Kör tester
npm test

# Starta worker
npm run worker:start

# Visa loggar
npm run worker:logs
```

Se [Utvecklingsguide](https://docs.claude-mem.ai/development) för detaljerade instruktioner.

---

## Felsökning

**Snabb Diagnostik:**

Om du upplever problem, beskriv problemet för Claude och felsökningsfärdigheten kommer automatiskt att aktiveras för att diagnostisera och ge lösningar.

**Vanliga Problem:**

- Worker startar inte → `npm run worker:restart`
- Inget sammanhang visas → `npm run test:context`
- Databasproblem → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Sökning fungerar inte → Kontrollera att FTS5-tabeller finns

Se [Felsökningsguide](https://docs.claude-mem.ai/troubleshooting) för kompletta lösningar.

---

## Bidrag

Bidrag är välkomna! Vänligen:

1. Forka repositoryt
2. Skapa en funktionsgren
3. Gör dina ändringar med tester
4. Uppdatera dokumentation
5. Skicka in en Pull Request

Se [Utvecklingsguide](https://docs.claude-mem.ai/development) för bidragsarbetsflöde.

---

## Licens

Detta projekt är licensierat under **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Alla rättigheter förbehållna.

Se [LICENSE](LICENSE)-filen för fullständiga detaljer.

**Vad Detta Betyder:**

- Du kan använda, modifiera och distribuera denna programvara fritt
- Om du modifierar och distribuerar på en nätverksserver måste du göra din källkod tillgänglig
- Härledda verk måste också licensieras under AGPL-3.0
- Det finns INGEN GARANTI för denna programvara

---

## Support

- **Dokumentation**: [docs/](docs/)
- **Problem**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Författare**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Byggt med Claude Agent SDK** | **Drivs av Claude Code** | **Gjort med TypeScript**