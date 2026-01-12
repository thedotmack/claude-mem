🌐 Dit is een automatische vertaling. Gemeenschapscorrecties zijn welkom!

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
  <a href="#snel-starten">Snel Starten</a> •
  <a href="#hoe-het-werkt">Hoe Het Werkt</a> •
  <a href="#zoektools">Zoektools</a> •
  <a href="#documentatie">Documentatie</a> •
  <a href="#configuratie">Configuratie</a> •
  <a href="#probleemoplossing">Probleemoplossing</a> •
  <a href="#licentie">Licentie</a>
</p>

<p align="center">
  Claude-Mem behoudt naadloos context tussen sessies door automatisch waarnemingen van toolgebruik vast te leggen, semantische samenvattingen te genereren en deze beschikbaar te maken voor toekomstige sessies. Dit stelt Claude in staat om continuïteit van kennis over projecten te behouden, zelfs nadat sessies eindigen of opnieuw verbinden.
</p>

---

## Snel Starten

Start een nieuwe Claude Code sessie in de terminal en voer de volgende commando's in:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Herstart Claude Code. Context van eerdere sessies verschijnt automatisch in nieuwe sessies.

**Belangrijkste Functies:**

- 🧠 **Persistent Geheugen** - Context blijft behouden tussen sessies
- 📊 **Progressieve Onthulling** - Gelaagde geheugenophaling met zichtbaarheid van tokenkosten
- 🔍 **Vaardigheidgebaseerd Zoeken** - Bevraag je projectgeschiedenis met mem-search vaardigheid
- 🖥️ **Web Viewer UI** - Real-time geheugenstroom op http://localhost:37777
- 💻 **Claude Desktop Vaardigheid** - Zoek geheugen vanuit Claude Desktop gesprekken
- 🔒 **Privacycontrole** - Gebruik `<private>` tags om gevoelige content uit te sluiten van opslag
- ⚙️ **Context Configuratie** - Fijnmazige controle over welke context wordt geïnjecteerd
- 🤖 **Automatische Werking** - Geen handmatige tussenkomst vereist
- 🔗 **Citaten** - Verwijs naar eerdere waarnemingen met ID's (toegang via http://localhost:37777/api/observation/{id} of bekijk alle in de web viewer op http://localhost:37777)
- 🧪 **Bètakanaal** - Probeer experimentele functies zoals Endless Mode via versieschakeling

---

## Documentatie

📚 **[Bekijk Volledige Documentatie](https://docs.claude-mem.ai/)** - Bladeren op de officiële website

### Aan de Slag

- **[Installatiegids](https://docs.claude-mem.ai/installation)** - Snel starten & geavanceerde installatie
- **[Gebruikersgids](https://docs.claude-mem.ai/usage/getting-started)** - Hoe Claude-Mem automatisch werkt
- **[Zoektools](https://docs.claude-mem.ai/usage/search-tools)** - Bevraag je projectgeschiedenis met natuurlijke taal
- **[Bètafuncties](https://docs.claude-mem.ai/beta-features)** - Probeer experimentele functies zoals Endless Mode

### Beste Praktijken

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - AI agent context optimalisatieprincipes
- **[Progressieve Onthulling](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofie achter Claude-Mem's context priming strategie

### Architectuur

- **[Overzicht](https://docs.claude-mem.ai/architecture/overview)** - Systeemcomponenten & gegevensstroom
- **[Architectuurevolutie](https://docs.claude-mem.ai/architecture-evolution)** - De reis van v3 naar v5
- **[Hooks Architectuur](https://docs.claude-mem.ai/hooks-architecture)** - Hoe Claude-Mem lifecycle hooks gebruikt
- **[Hooks Referentie](https://docs.claude-mem.ai/architecture/hooks)** - 7 hook scripts uitgelegd
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API & Bun beheer
- **[Database](https://docs.claude-mem.ai/architecture/database)** - SQLite schema & FTS5 zoeken
- **[Zoekarchitectuur](https://docs.claude-mem.ai/architecture/search-architecture)** - Hybride zoeken met Chroma vector database

### Configuratie & Ontwikkeling

- **[Configuratie](https://docs.claude-mem.ai/configuration)** - Omgevingsvariabelen & instellingen
- **[Ontwikkeling](https://docs.claude-mem.ai/development)** - Bouwen, testen, bijdragen
- **[Probleemoplossing](https://docs.claude-mem.ai/troubleshooting)** - Veelvoorkomende problemen & oplossingen

---

## Hoe Het Werkt

**Kerncomponenten:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook scripts)
2. **Slimme Installatie** - Gecachte afhankelijkheidscontrole (pre-hook script, geen lifecycle hook)
3. **Worker Service** - HTTP API op poort 37777 met web viewer UI en 10 zoekeindpunten, beheerd door Bun
4. **SQLite Database** - Slaat sessies, waarnemingen, samenvattingen op
5. **mem-search Vaardigheid** - Natuurlijke taal queries met progressieve onthulling
6. **Chroma Vector Database** - Hybride semantisch + zoekwoord zoeken voor intelligente context ophaling

Zie [Architectuuroverzicht](https://docs.claude-mem.ai/architecture/overview) voor details.

---

## mem-search Vaardigheid

Claude-Mem biedt intelligent zoeken via de mem-search vaardigheid die automatisch wordt aangeroepen wanneer je vraagt over eerder werk:

**Hoe Het Werkt:**
- Vraag gewoon natuurlijk: *"Wat hebben we vorige sessie gedaan?"* of *"Hebben we deze bug eerder opgelost?"*
- Claude roept automatisch de mem-search vaardigheid aan om relevante context te vinden

**Beschikbare Zoekoperaties:**

1. **Search Observations** - Volledige tekst zoeken door waarnemingen
2. **Search Sessions** - Volledige tekst zoeken door sessiesamenvattingen
3. **Search Prompts** - Zoek ruwe gebruikersverzoeken
4. **By Concept** - Vind op concepttags (discovery, problem-solution, pattern, etc.)
5. **By File** - Vind waarnemingen die specifieke bestanden refereren
6. **By Type** - Vind op type (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Krijg recente sessiecontext voor een project
8. **Timeline** - Krijg uniforme tijdlijn van context rond een specifiek tijdstip
9. **Timeline by Query** - Zoek naar waarnemingen en krijg tijdlijncontext rond beste match
10. **API Help** - Krijg zoek API documentatie

**Voorbeeld Natuurlijke Taal Queries:**

```
"Welke bugs hebben we vorige sessie opgelost?"
"Hoe hebben we authenticatie geïmplementeerd?"
"Welke wijzigingen zijn gemaakt aan worker-service.ts?"
"Laat me recent werk aan dit project zien"
"Wat gebeurde er toen we de viewer UI toevoegden?"
```

Zie [Zoektools Gids](https://docs.claude-mem.ai/usage/search-tools) voor gedetailleerde voorbeelden.

---

## Bètafuncties

Claude-Mem biedt een **bètakanaal** met experimentele functies zoals **Endless Mode** (biomimetische geheugenarchitectuur voor uitgebreide sessies). Schakel tussen stabiele en bètaversies vanuit de web viewer UI op http://localhost:37777 → Settings.

Zie **[Bètafuncties Documentatie](https://docs.claude-mem.ai/beta-features)** voor details over Endless Mode en hoe je het kunt proberen.

---

## Systeemvereisten

- **Node.js**: 18.0.0 of hoger
- **Claude Code**: Nieuwste versie met plugin ondersteuning
- **Bun**: JavaScript runtime en procesbeheer (automatisch geïnstalleerd indien ontbreekt)
- **uv**: Python package manager voor vector zoeken (automatisch geïnstalleerd indien ontbreekt)
- **SQLite 3**: Voor persistente opslag (meegeleverd)

---

## Configuratie

Instellingen worden beheerd in `~/.claude-mem/settings.json` (automatisch aangemaakt met standaardinstellingen bij eerste run). Configureer AI model, worker poort, data directory, logniveau en context injectie-instellingen.

Zie de **[Configuratiegids](https://docs.claude-mem.ai/configuration)** voor alle beschikbare instellingen en voorbeelden.

---

## Ontwikkeling

Zie de **[Ontwikkelingsgids](https://docs.claude-mem.ai/development)** voor bouwinstructies, testen en bijdrageworkflow.

---

## Probleemoplossing

Als je problemen ervaart, beschrijf het probleem aan Claude en de troubleshoot vaardigheid zal automatisch diagnosticeren en oplossingen bieden.

Zie de **[Probleemoplossingsgids](https://docs.claude-mem.ai/troubleshooting)** voor veelvoorkomende problemen en oplossingen.

---

## Bugrapporten

Maak uitgebreide bugrapporten met de geautomatiseerde generator:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Bijdragen

Bijdragen zijn welkom! Gelieve:

1. Fork de repository
2. Maak een feature branch
3. Maak je wijzigingen met tests
4. Update documentatie
5. Dien een Pull Request in

Zie [Ontwikkelingsgids](https://docs.claude-mem.ai/development) voor bijdrageworkflow.

---

## Licentie

Dit project is gelicentieerd onder de **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Alle rechten voorbehouden.

Zie het [LICENSE](LICENSE) bestand voor volledige details.

**Wat Dit Betekent:**

- Je kunt deze software vrijelijk gebruiken, aanpassen en distribueren
- Als je aanpast en implementeert op een netwerkserver, moet je je broncode beschikbaar maken
- Afgeleide werken moeten ook gelicentieerd zijn onder AGPL-3.0
- Er is GEEN GARANTIE voor deze software

**Opmerking over Ragtime**: De `ragtime/` directory is afzonderlijk gelicentieerd onder de **PolyForm Noncommercial License 1.0.0**. Zie [ragtime/LICENSE](ragtime/LICENSE) voor details.

---

## Ondersteuning

- **Documentatie**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Auteur**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Gebouwd met Claude Agent SDK** | **Aangedreven door Claude Code** | **Gemaakt met TypeScript**