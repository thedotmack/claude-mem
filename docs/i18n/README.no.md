🌐 Dette er en automatisk oversettelse. Bidrag fra fellesskapet er velkomne!

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

<h4 align="center">Vedvarende minnekomprimeringssystem bygget for <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#hurtigstart">Hurtigstart</a> •
  <a href="#hvordan-det-fungerer">Hvordan Det Fungerer</a> •
  <a href="#mcp-søkeverktøy">Søkeverktøy</a> •
  <a href="#dokumentasjon">Dokumentasjon</a> •
  <a href="#konfigurasjon">Konfigurasjon</a> •
  <a href="#feilsøking">Feilsøking</a> •
  <a href="#lisens">Lisens</a>
</p>

<p align="center">
  Claude-Mem bevarer sømløst kontekst på tvers av økter ved automatisk å fange opp observasjoner av verktøybruk, generere semantiske sammendrag, og gjøre dem tilgjengelige for fremtidige økter. Dette gjør det mulig for Claude å opprettholde kunnskapskontinuitet om prosjekter selv etter at økter avsluttes eller gjenopprettes.
</p>

---

## Hurtigstart

Start en ny Claude Code-økt i terminalen og skriv inn følgende kommandoer:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Start Claude Code på nytt. Kontekst fra tidligere økter vil automatisk vises i nye økter.

**Nøkkelfunksjoner:**

- 🧠 **Vedvarende Minne** - Kontekst overlever på tvers av økter
- 📊 **Progressiv Avsløring** - Lagdelt minnehenting med synlighet av tokenkostnader
- 🔍 **Ferdighetsbasert Søk** - Spør om prosjekthistorikken din med mem-search-ferdigheten
- 🖥️ **Nettleser UI** - Sanntids minnestrøm på http://localhost:37777
- 💻 **Claude Desktop-ferdighet** - Søk i minne fra Claude Desktop-samtaler
- 🔒 **Personvernkontroll** - Bruk `<private>`-tagger for å ekskludere sensitivt innhold fra lagring
- ⚙️ **Kontekstkonfigurasjon** - Finjustert kontroll over hvilken kontekst som injiseres
- 🤖 **Automatisk Drift** - Ingen manuell inngripen nødvendig
- 🔗 **Kildehenvisninger** - Referer til tidligere observasjoner med ID-er (tilgang via http://localhost:37777/api/observation/{id} eller se alle i nettviseren på http://localhost:37777)
- 🧪 **Beta-kanal** - Prøv eksperimentelle funksjoner som Endless Mode via versjonsbytte

---

## Dokumentasjon

📚 **[Se Full Dokumentasjon](https://docs.claude-mem.ai/)** - Bla gjennom på det offisielle nettstedet

### Komme I Gang

- **[Installasjonsveiledning](https://docs.claude-mem.ai/installation)** - Hurtigstart og avansert installasjon
- **[Brukerveiledning](https://docs.claude-mem.ai/usage/getting-started)** - Hvordan Claude-Mem fungerer automatisk
- **[Søkeverktøy](https://docs.claude-mem.ai/usage/search-tools)** - Spør om prosjekthistorikken din med naturlig språk
- **[Beta-funksjoner](https://docs.claude-mem.ai/beta-features)** - Prøv eksperimentelle funksjoner som Endless Mode

### Beste Praksis

- **[Kontekst Engineering](https://docs.claude-mem.ai/context-engineering)** - Optimaliseringsprinsipper for AI-agentkontekst
- **[Progressiv Avsløring](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofien bak Claude-Mems strategi for kontekstpriming

### Arkitektur

- **[Oversikt](https://docs.claude-mem.ai/architecture/overview)** - Systemkomponenter og dataflyt
- **[Arkitekturutvikling](https://docs.claude-mem.ai/architecture-evolution)** - Reisen fra v3 til v5
- **[Hooks-arkitektur](https://docs.claude-mem.ai/hooks-architecture)** - Hvordan Claude-Mem bruker livssyklus-hooks
- **[Hooks-referanse](https://docs.claude-mem.ai/architecture/hooks)** - 7 hook-skript forklart
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API og Bun-administrasjon
- **[Database](https://docs.claude-mem.ai/architecture/database)** - SQLite-skjema og FTS5-søk
- **[Søkearkitektur](https://docs.claude-mem.ai/architecture/search-architecture)** - Hybridsøk med Chroma vektordatabase

### Konfigurasjon og Utvikling

- **[Konfigurasjon](https://docs.claude-mem.ai/configuration)** - Miljøvariabler og innstillinger
- **[Utvikling](https://docs.claude-mem.ai/development)** - Bygging, testing, bidragsflyt
- **[Feilsøking](https://docs.claude-mem.ai/troubleshooting)** - Vanlige problemer og løsninger

---

## Hvordan Det Fungerer

**Kjernekomponenter:**

1. **5 Livssyklus-Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook-skript)
2. **Smart Installasjon** - Bufret avhengighetssjekker (pre-hook-skript, ikke en livssyklus-hook)
3. **Worker Service** - HTTP API på port 37777 med nettleser UI og 10 søkeendepunkter, administrert av Bun
4. **SQLite Database** - Lagrer økter, observasjoner, sammendrag
5. **mem-search-ferdighet** - Naturligspråklige spørringer med progressiv avsløring
6. **Chroma Vektordatabase** - Hybrid semantisk + nøkkelordsøk for intelligent konteksthenting

Se [Arkitekturoversikt](https://docs.claude-mem.ai/architecture/overview) for detaljer.

---

## mem-search-ferdighet

Claude-Mem tilbyr intelligent søk gjennom mem-search-ferdigheten som automatisk aktiveres når du spør om tidligere arbeid:

**Hvordan Det Fungerer:**
- Bare spør naturlig: *"Hva gjorde vi forrige økt?"* eller *"Fikset vi denne feilen før?"*
- Claude aktiverer automatisk mem-search-ferdigheten for å finne relevant kontekst

**Tilgjengelige Søkeoperasjoner:**

1. **Search Observations** - Fulltekstsøk på tvers av observasjoner
2. **Search Sessions** - Fulltekstsøk på tvers av øktsammendrag
3. **Search Prompts** - Søk i rå brukerforespørsler
4. **By Concept** - Finn etter konsept-tagger (discovery, problem-solution, pattern, osv.)
5. **By File** - Finn observasjoner som refererer til spesifikke filer
6. **By Type** - Finn etter type (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Få nylig øktkontekst for et prosjekt
8. **Timeline** - Få samlet tidslinje av kontekst rundt et spesifikt tidspunkt
9. **Timeline by Query** - Søk etter observasjoner og få tidslinjekontekst rundt beste treff
10. **API Help** - Få søke-API-dokumentasjon

**Eksempel på Naturligspråklige Spørringer:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

Se [Søkeverktøy-veiledning](https://docs.claude-mem.ai/usage/search-tools) for detaljerte eksempler.

---

## Beta-funksjoner

Claude-Mem tilbyr en **beta-kanal** med eksperimentelle funksjoner som **Endless Mode** (biomimetisk minnearkitektur for utvidede økter). Bytt mellom stabile og beta-versjoner fra nettleser-UI på http://localhost:37777 → Settings.

Se **[Beta-funksjoner Dokumentasjon](https://docs.claude-mem.ai/beta-features)** for detaljer om Endless Mode og hvordan du prøver det.

---

## Systemkrav

- **Node.js**: 18.0.0 eller høyere
- **Claude Code**: Nyeste versjon med plugin-støtte
- **Bun**: JavaScript-runtime og prosessadministrator (autoinstalleres hvis mangler)
- **uv**: Python-pakkeadministrator for vektorsøk (autoinstalleres hvis mangler)
- **SQLite 3**: For vedvarende lagring (inkludert)

---

## Konfigurasjon

Innstillinger administreres i `~/.claude-mem/settings.json` (opprettes automatisk med standardverdier ved første kjøring). Konfigurer AI-modell, worker-port, datakatalog, loggnivå og innstillinger for kontekstinjeksjon.

Se **[Konfigurasjonsveiledning](https://docs.claude-mem.ai/configuration)** for alle tilgjengelige innstillinger og eksempler.

---

## Utvikling

Se **[Utviklingsveiledning](https://docs.claude-mem.ai/development)** for byggeinstruksjoner, testing og bidragsflyt.

---

## Feilsøking

Hvis du opplever problemer, beskriv problemet til Claude og troubleshoot-ferdigheten vil automatisk diagnostisere og gi løsninger.

Se **[Feilsøkingsveiledning](https://docs.claude-mem.ai/troubleshooting)** for vanlige problemer og løsninger.

---

## Feilrapporter

Opprett omfattende feilrapporter med den automatiserte generatoren:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Bidra

Bidrag er velkomne! Vennligst:

1. Fork repositoryet
2. Opprett en feature-gren
3. Gjør endringene dine med tester
4. Oppdater dokumentasjonen
5. Send inn en Pull Request

Se [Utviklingsveiledning](https://docs.claude-mem.ai/development) for bidragsflyt.

---

## License

This project is licensed under the **Apache License 2.0** (Apache-2.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

Apache-2.0 allows broad use, modification, distribution, and commercial use, subject to its terms.

**Ragtime note**: The ragtime/ directory is licensed under the **Apache License 2.0**. See [ragtime/LICENSE](ragtime/LICENSE) for details.

---


## Støtte

- **Dokumentasjon**: [docs/](docs/)
- **Problemer**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Forfatter**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Bygget med Claude Agent SDK** | **Drevet av Claude Code** | **Laget med TypeScript**

---