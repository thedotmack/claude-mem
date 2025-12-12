🌐 Dit is een geautomatiseerde vertaling. Bijdragen van de community zijn welkom!

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

<h4 align="center">Persistent geheugencompressiesysteem gebouwd voor <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#snelle-start">Snelle Start</a> •
  <a href="#hoe-het-werkt">Hoe Het Werkt</a> •
  <a href="#zoektools">Zoektools</a> •
  <a href="#documentatie">Documentatie</a> •
  <a href="#configuratie">Configuratie</a> •
  <a href="#probleemoplossing">Probleemoplossing</a> •
  <a href="#licentie">Licentie</a>
</p>

<p align="center">
  Claude-Mem bewaart naadloos context tussen sessies door automatisch waarnemingen van toolgebruik vast te leggen, semantische samenvattingen te genereren en deze beschikbaar te maken voor toekomstige sessies. Dit stelt Claude in staat om continuïteit van kennis over projecten te behouden, zelfs nadat sessies zijn beëindigd of opnieuw verbinden.
</p>

---

## Snelle Start

Start een nieuwe Claude Code sessie in de terminal en voer de volgende commando's in:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Herstart Claude Code. Context van eerdere sessies verschijnt automatisch in nieuwe sessies.

**Belangrijkste Functies:**

- 🧠 **Persistent Geheugen** - Context blijft behouden tussen sessies
- 📊 **Progressieve Onthulling** - Gelaagd geheugen ophalen met zichtbaarheid van tokenkosten
- 🔍 **Op Vaardigheden Gebaseerd Zoeken** - Doorzoek je projectgeschiedenis met mem-search vaardigheid (~2.250 token besparing)
- 🖥️ **Web Viewer UI** - Real-time geheugenstroom op http://localhost:37777
- 🔒 **Privacycontrole** - Gebruik `<private>` tags om gevoelige inhoud uit te sluiten van opslag
- ⚙️ **Contextconfiguratie** - Fijnmazige controle over welke context wordt geïnjecteerd
- 🤖 **Automatische Werking** - Geen handmatige tussenkomst vereist
- 🔗 **Citaten** - Refereer naar eerdere beslissingen met `claude-mem://` URI's
- 🧪 **Bètakanaal** - Probeer experimentele functies zoals Endless Mode via versieschakeling

---

## Documentatie

📚 **[Bekijk Volledige Documentatie](docs/)** - Blader door markdown documentatie op GitHub

💻 **Lokaal Voorbeeld**: Draai Mintlify documentatie lokaal:

```bash
cd docs
npx mintlify dev
```

### Aan de Slag

- **[Installatiegids](https://docs.claude-mem.ai/installation)** - Snelle start & geavanceerde installatie
- **[Gebruiksgids](https://docs.claude-mem.ai/usage/getting-started)** - Hoe Claude-Mem automatisch werkt
- **[Zoektools](https://docs.claude-mem.ai/usage/search-tools)** - Doorzoek je projectgeschiedenis met natuurlijke taal
- **[Bètafuncties](https://docs.claude-mem.ai/beta-features)** - Probeer experimentele functies zoals Endless Mode

### Beste Praktijken

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - Optimalisatieprincipes voor AI-agent context
- **[Progressieve Onthulling](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofie achter Claude-Mem's context priming-strategie

### Architectuur

- **[Overzicht](https://docs.claude-mem.ai/architecture/overview)** - Systeemcomponenten & gegevensstroom
- **[Architectuurevolutie](https://docs.claude-mem.ai/architecture-evolution)** - De reis van v3 naar v5
- **[Hooks Architectuur](https://docs.claude-mem.ai/hooks-architecture)** - Hoe Claude-Mem lifecycle hooks gebruikt
- **[Hooks Referentie](https://docs.claude-mem.ai/architecture/hooks)** - 7 hook scripts uitgelegd
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API & PM2 beheer
- **[Database](https://docs.claude-mem.ai/architecture/database)** - SQLite schema & FTS5 zoeken
- **[Zoekarchitectuur](https://docs.claude-mem.ai/architecture/search-architecture)** - Hybride zoeken met Chroma vector database

### Configuratie & Ontwikkeling

- **[Configuratie](https://docs.claude-mem.ai/configuration)** - Omgevingsvariabelen & instellingen
- **[Ontwikkeling](https://docs.claude-mem.ai/development)** - Bouwen, testen, bijdragen
- **[Probleemoplossing](https://docs.claude-mem.ai/troubleshooting)** - Veelvoorkomende problemen & oplossingen

---

## Hoe Het Werkt

```
┌─────────────────────────────────────────────────────────────┐
│ Sessie Start → Injecteer recente waarnemingen als context  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Gebruikersprompts → Creëer sessie, sla gebruikersprompts op│
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Tool Uitvoeringen → Leg waarnemingen vast (Read, Write, etc.)│
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Worker Processen → Extraheer leerpunten via Claude Agent SDK│
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Sessie Eindigt → Genereer samenvatting, klaar voor volgende │
└─────────────────────────────────────────────────────────────┘
```

**Kerncomponenten:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook scripts)
2. **Slimme Installatie** - Gecachte dependency checker (pre-hook script, geen lifecycle hook)
3. **Worker Service** - HTTP API op poort 37777 met web viewer UI en 10 zoekmogelijkheden, beheerd door PM2
4. **SQLite Database** - Slaat sessies, waarnemingen, samenvattingen op met FTS5 full-text zoeken
5. **mem-search Vaardigheid** - Natuurlijke taal queries met progressieve onthulling (~2.250 token besparing vs MCP)
6. **Chroma Vector Database** - Hybride semantisch + zoekwoord zoeken voor intelligente context ophaling

Zie [Architectuuroverzicht](https://docs.claude-mem.ai/architecture/overview) voor details.

---

## mem-search Vaardigheid

Claude-Mem biedt intelligent zoeken via de mem-search vaardigheid die automatisch wordt aangeroepen wanneer je vraagt naar eerder werk:

**Hoe Het Werkt:**
- Vraag gewoon natuurlijk: *"Wat hebben we de vorige sessie gedaan?"* of *"Hebben we deze bug eerder opgelost?"*
- Claude roept automatisch de mem-search vaardigheid aan om relevante context te vinden
- ~2.250 token besparing per sessiestart vs MCP-aanpak

**Beschikbare Zoekoperaties:**

1. **Zoek Waarnemingen** - Full-text zoeken over waarnemingen
2. **Zoek Sessies** - Full-text zoeken over sessiesamenvattingen
3. **Zoek Prompts** - Zoek ruwe gebruikersverzoeken
4. **Op Concept** - Zoek op concept tags (discovery, problem-solution, pattern, etc.)
5. **Op Bestand** - Zoek waarnemingen die verwijzen naar specifieke bestanden
6. **Op Type** - Zoek op type (decision, bugfix, feature, refactor, discovery, change)
7. **Recente Context** - Verkrijg recente sessiecontext voor een project
8. **Tijdlijn** - Verkrijg uniforme tijdlijn van context rond een specifiek tijdstip
9. **Tijdlijn op Query** - Zoek naar waarnemingen en verkrijg tijdlijncontext rond beste match
10. **API Help** - Verkrijg zoek API-documentatie

**Voorbeeld Natuurlijke Taal Queries:**

```
"Welke bugs hebben we de vorige sessie opgelost?"
"Hoe hebben we authenticatie geïmplementeerd?"
"Welke wijzigingen zijn aangebracht in worker-service.ts?"
"Laat me recent werk aan dit project zien"
"Wat was er aan de hand toen we de viewer UI toevoegden?"
```

Zie [Zoektools Gids](https://docs.claude-mem.ai/usage/search-tools) voor gedetailleerde voorbeelden.

---

## Bètafuncties & Endless Mode

Claude-Mem biedt een **bètakanaal** met experimentele functies. Schakel rechtstreeks vanuit de web viewer UI tussen stabiele en bètaversies.

### Hoe Bèta Te Proberen

1. Open http://localhost:37777
2. Klik op Instellingen (tandwielpictogram)
3. In **Versiekanaal**, klik op "Try Beta (Endless Mode)"
4. Wacht tot de worker opnieuw start

Je geheugengegevens blijven behouden bij het wisselen van versies.

### Endless Mode (Bèta)

De vlaggenschip bètafunctie is **Endless Mode** - een biomimetische geheugenarchitectuur die de sessieduur dramatisch verlengt:

**Het Probleem**: Standaard Claude Code sessies bereiken contextlimieten na ~50 toolgebruiken. Elke tool voegt 1-10k+ tokens toe, en Claude synthetiseert alle eerdere outputs opnieuw bij elke respons (O(N²) complexiteit).

**De Oplossing**: Endless Mode comprimeert tool outputs naar ~500-token waarnemingen en transformeert het transcript in real-time:

```
Werkgeheugen (Context):     Gecomprimeerde waarnemingen (~500 tokens elk)
Archiefgeheugen (Schijf):   Volledige tool outputs bewaard voor ophalen
```

**Verwachte Resultaten**:
- ~95% tokenreductie in contextvenster
- ~20x meer toolgebruiken voor context-uitputting
- Lineaire O(N) schaling in plaats van kwadratische O(N²)
- Volledige transcripten bewaard voor perfecte herinnering

**Voorbehoud**: Voegt latentie toe (60-90s per tool voor waarnemingsgeneratie), nog steeds experimenteel.

Zie [Bètafuncties Documentatie](https://docs.claude-mem.ai/beta-features) voor details.

---

## Wat Is Nieuw

**v6.4.9 - Contextconfiguratie-instellingen:**
- 11 nieuwe instellingen voor fijnmazige controle over context-injectie
- Configureer weergave van token economie, waarnemingsfiltering op type/concept
- Beheer aantal waarnemingen en welke velden worden weergegeven

**v6.4.0 - Dubbele-Tag Privacysysteem:**
- `<private>` tags voor gebruikersgecontroleerde privacy - wikkel gevoelige inhoud in om uit te sluiten van opslag
- Systeemniveau `<claude-mem-context>` tags voorkomen recursieve waarnemingsopslag
- Edge-verwerking zorgt ervoor dat privé-inhoud nooit de database bereikt

**v6.3.0 - Versiekanaal:**
- Schakel tussen stabiele en bètaversies vanuit de web viewer UI
- Probeer experimentele functies zoals Endless Mode zonder handmatige git-operaties

**Eerdere Hoogtepunten:**
- **v6.0.0**: Belangrijke verbeteringen in sessiebeheer & transcript verwerking
- **v5.5.0**: mem-search vaardigheid verbetering met 100% effectiviteitspercentage
- **v5.4.0**: Op vaardigheden gebaseerde zoekarchitectuur (~2.250 tokens bespaard per sessie)
- **v5.1.0**: Webgebaseerde viewer UI met real-time updates
- **v5.0.0**: Hybride zoeken met Chroma vector database

Zie [CHANGELOG.md](CHANGELOG.md) voor volledige versiegeschiedenis.

---

## Systeemvereisten

- **Node.js**: 18.0.0 of hoger
- **Claude Code**: Laatste versie met plugin-ondersteuning
- **PM2**: Procesbeheerder (meegeleverd - geen globale installatie vereist)
- **SQLite 3**: Voor persistente opslag (meegeleverd)

---

## Belangrijkste Voordelen

### Progressieve Onthulling Context

- **Gelaagd geheugen ophalen** weerspiegelt menselijke geheugenpatronen
- **Laag 1 (Index)**: Zie welke waarnemingen bestaan met tokenkosten bij sessiestart
- **Laag 2 (Details)**: Haal volledige verhalen op aanvraag op via MCP zoeken
- **Laag 3 (Perfecte Herinnering)**: Toegang tot broncode en originele transcripten
- **Slimme besluitvorming**: Token tellingen helpen Claude kiezen tussen het ophalen van details of het lezen van code
- **Type-indicatoren**: Visuele hints (🔴 kritiek, 🟤 beslissing, 🔵 informatief) benadrukken waarnemingsbelang

### Automatisch Geheugen

- Context automatisch geïnjecteerd wanneer Claude start
- Geen handmatige commando's of configuratie nodig
- Werkt transparant op de achtergrond

### Volledige Geschiedenis Zoeken

- Zoek over alle sessies en waarnemingen
- FTS5 full-text zoeken voor snelle queries
- Citaten linken terug naar specifieke waarnemingen

### Gestructureerde Waarnemingen

- AI-aangedreven extractie van leerpunten
- Gecategoriseerd op type (decision, bugfix, feature, etc.)
- Getagd met concepten en bestandsverwijzingen

### Multi-Prompt Sessies

- Sessies omvatten meerdere gebruikersprompts
- Context behouden over `/clear` commando's heen
- Volg hele gespreksthreads

---

## Configuratie

Instellingen worden beheerd in `~/.claude-mem/settings.json`. Het bestand wordt automatisch aangemaakt met standaardwaarden bij eerste keer draaien.

**Beschikbare Instellingen:**

| Instelling | Standaard | Beschrijving |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | AI-model voor waarnemingen |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | Worker service poort |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | Gegevensmap locatie |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | Log verbositeit (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | Python versie voor chroma-mcp |
| `CLAUDE_CODE_PATH` | _(auto-detectie)_ | Pad naar Claude executable |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Aantal waarnemingen te injecteren bij SessionStart |

**Instellingenbeheer:**

```bash
# Bewerk instellingen via CLI helper
./claude-mem-settings.sh

# Of bewerk direct
nano ~/.claude-mem/settings.json

# Bekijk huidige instellingen
curl http://localhost:37777/api/settings
```

**Instellingenbestand Formaat:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

Zie [Configuratiegids](https://docs.claude-mem.ai/configuration) voor details.

---

## Ontwikkeling

```bash
# Clone en bouw
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# Draai tests
npm test

# Start worker
npm run worker:start

# Bekijk logs
npm run worker:logs
```

Zie [Ontwikkelingsgids](https://docs.claude-mem.ai/development) voor gedetailleerde instructies.

---

## Probleemoplossing

**Snelle Diagnose:**

Als je problemen ondervindt, beschrijf het probleem aan Claude en de troubleshoot vaardigheid wordt automatisch geactiveerd om te diagnosticeren en oplossingen te bieden.

**Veelvoorkomende Problemen:**

- Worker start niet → `npm run worker:restart`
- Geen context verschijnt → `npm run test:context`
- Database problemen → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Zoeken werkt niet → Controleer of FTS5 tabellen bestaan

Zie [Probleemoplossingsgids](https://docs.claude-mem.ai/troubleshooting) voor volledige oplossingen.

---

## Bijdragen

Bijdragen zijn welkom! Gelieve:

1. Fork de repository
2. Creëer een feature branch
3. Maak je wijzigingen met tests
4. Update documentatie
5. Dien een Pull Request in

Zie [Ontwikkelingsgids](https://docs.claude-mem.ai/development) voor bijdrage workflow.

---

## Licentie

Dit project is gelicentieerd onder de **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Alle rechten voorbehouden.

Zie het [LICENSE](LICENSE) bestand voor volledige details.

**Wat Dit Betekent:**

- Je kunt deze software vrij gebruiken, aanpassen en distribueren
- Als je wijzigt en implementeert op een netwerkserver, moet je je broncode beschikbaar maken
- Afgeleide werken moeten ook gelicentieerd zijn onder AGPL-3.0
- Er is GEEN GARANTIE voor deze software

---

## Ondersteuning

- **Documentatie**: [docs/](docs/)
- **Problemen**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Auteur**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Gebouwd met Claude Agent SDK** | **Aangedreven door Claude Code** | **Gemaakt met TypeScript**