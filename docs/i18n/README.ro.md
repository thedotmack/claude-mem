🌐 Aceasta este o traducere automată. Corecțiile din partea comunității sunt binevenite!

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

<h4 align="center">Sistem persistent de compresie a memoriei construit pentru <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#start-rapid">Start Rapid</a> •
  <a href="#cum-funcționează">Cum Funcționează</a> •
  <a href="#instrumente-de-căutare-mcp">Instrumente de Căutare</a> •
  <a href="#documentație">Documentație</a> •
  <a href="#configurare">Configurare</a> •
  <a href="#depanare">Depanare</a> •
  <a href="#licență">Licență</a>
</p>

<p align="center">
  Claude-Mem păstrează contextul fără întrerupere între sesiuni prin capturarea automată a observațiilor de utilizare a instrumentelor, generarea de rezumate semantice și punerea lor la dispoziție în sesiunile viitoare. Aceasta permite lui Claude să mențină continuitatea cunoștințelor despre proiecte chiar și după încheierea sau reconectarea sesiunilor.
</p>

---

## Start Rapid

Porniți o nouă sesiune Claude Code în terminal și introduceți următoarele comenzi:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Reporniți Claude Code. Contextul din sesiunile anterioare va apărea automat în sesiunile noi.

**Caracteristici Principale:**

- 🧠 **Memorie Persistentă** - Contextul supraviețuiește între sesiuni
- 📊 **Dezvăluire Progresivă** - Recuperare stratificată a memoriei cu vizibilitatea costurilor în tokeni
- 🔍 **Căutare Bazată pe Abilități** - Interogați istoricul proiectului cu abilitatea mem-search
- 🖥️ **Interfață Web Viewer** - Flux de memorie în timp real la http://localhost:37777
- 💻 **Abilitate Claude Desktop** - Căutați în memorie din conversațiile Claude Desktop
- 🔒 **Control al Confidențialității** - Utilizați etichete `<private>` pentru a exclude conținut sensibil de la stocare
- ⚙️ **Configurare Context** - Control fin asupra contextului care este injectat
- 🤖 **Operare Automată** - Nu necesită intervenție manuală
- 🔗 **Citări** - Referință la observații anterioare cu ID-uri (accesați prin http://localhost:37777/api/observation/{id} sau vizualizați toate în web viewer la http://localhost:37777)
- 🧪 **Canal Beta** - Încercați funcții experimentale precum Endless Mode prin comutarea versiunii

---

## Documentație

📚 **[Vizualizați Documentația Completă](https://docs.claude-mem.ai/)** - Răsfoiți pe site-ul oficial

### Introducere

- **[Ghid de Instalare](https://docs.claude-mem.ai/installation)** - Start rapid și instalare avansată
- **[Ghid de Utilizare](https://docs.claude-mem.ai/usage/getting-started)** - Cum funcționează Claude-Mem automat
- **[Instrumente de Căutare](https://docs.claude-mem.ai/usage/search-tools)** - Interogați istoricul proiectului cu limbaj natural
- **[Funcții Beta](https://docs.claude-mem.ai/beta-features)** - Încercați funcții experimentale precum Endless Mode

### Practici Recomandate

- **[Inginerie Context](https://docs.claude-mem.ai/context-engineering)** - Principii de optimizare a contextului pentru agenți AI
- **[Dezvăluire Progresivă](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofia din spatele strategiei de pregătire a contextului Claude-Mem

### Arhitectură

- **[Prezentare Generală](https://docs.claude-mem.ai/architecture/overview)** - Componente de sistem și flux de date
- **[Evoluția Arhitecturii](https://docs.claude-mem.ai/architecture-evolution)** - Parcursul de la v3 la v5
- **[Arhitectura Hooks](https://docs.claude-mem.ai/hooks-architecture)** - Cum folosește Claude-Mem hook-urile de ciclu de viață
- **[Referință Hooks](https://docs.claude-mem.ai/architecture/hooks)** - 7 scripturi de hook explicate
- **[Serviciu Worker](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API și gestionare Bun
- **[Baza de Date](https://docs.claude-mem.ai/architecture/database)** - Schemă SQLite și căutare FTS5
- **[Arhitectura Căutării](https://docs.claude-mem.ai/architecture/search-architecture)** - Căutare hibridă cu baza de date vectorială Chroma

### Configurare și Dezvoltare

- **[Configurare](https://docs.claude-mem.ai/configuration)** - Variabile de mediu și setări
- **[Dezvoltare](https://docs.claude-mem.ai/development)** - Construire, testare, contribuție
- **[Depanare](https://docs.claude-mem.ai/troubleshooting)** - Probleme comune și soluții

---

## Cum Funcționează

**Componente Principale:**

1. **5 Hook-uri de Ciclu de Viață** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 scripturi de hook)
2. **Instalare Inteligentă** - Verificator de dependențe în cache (script pre-hook, nu un hook de ciclu de viață)
3. **Serviciu Worker** - HTTP API pe portul 37777 cu interfață web viewer și 10 endpoint-uri de căutare, gestionat de Bun
4. **Bază de Date SQLite** - Stochează sesiuni, observații, rezumate
5. **Abilitatea mem-search** - Interogări în limbaj natural cu dezvăluire progresivă
6. **Bază de Date Vectorială Chroma** - Căutare hibridă semantică + cuvinte cheie pentru recuperare inteligentă a contextului

Consultați [Prezentarea Generală a Arhitecturii](https://docs.claude-mem.ai/architecture/overview) pentru detalii.

---

## Abilitatea mem-search

Claude-Mem oferă căutare inteligentă prin abilitatea mem-search care se invocă automat când întrebați despre lucrul trecut:

**Cum Funcționează:**
- Întrebați natural: *"Ce am făcut în sesiunea trecută?"* sau *"Am rezolvat acest bug înainte?"*
- Claude invocă automat abilitatea mem-search pentru a găsi contextul relevant

**Operații de Căutare Disponibile:**

1. **Search Observations** - Căutare full-text în observații
2. **Search Sessions** - Căutare full-text în rezumatele sesiunilor
3. **Search Prompts** - Căutare în cererile brute ale utilizatorilor
4. **By Concept** - Găsire după etichete de concept (discovery, problem-solution, pattern, etc.)
5. **By File** - Găsire de observații care fac referire la fișiere specifice
6. **By Type** - Găsire după tip (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Obținere context recent al sesiunii pentru un proiect
8. **Timeline** - Obținere cronologie unificată a contextului în jurul unui punct specific în timp
9. **Timeline by Query** - Căutare observații și obținere context cronologic în jurul celei mai bune potriviri
10. **API Help** - Obținere documentație API de căutare

**Exemple de Interogări în Limbaj Natural:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

Consultați [Ghidul Instrumentelor de Căutare](https://docs.claude-mem.ai/usage/search-tools) pentru exemple detaliate.

---

## Funcții Beta

Claude-Mem oferă un **canal beta** cu funcții experimentale precum **Endless Mode** (arhitectură de memorie biomimetică pentru sesiuni extinse). Comutați între versiunile stabile și beta din interfața web viewer la http://localhost:37777 → Settings.

Consultați **[Documentația Funcțiilor Beta](https://docs.claude-mem.ai/beta-features)** pentru detalii despre Endless Mode și cum să îl încercați.

---

## Cerințe de Sistem

- **Node.js**: 18.0.0 sau superior
- **Claude Code**: Versiunea cea mai recentă cu suport pentru plugin-uri
- **Bun**: Runtime JavaScript și manager de procese (instalat automat dacă lipsește)
- **uv**: Manager de pachete Python pentru căutare vectorială (instalat automat dacă lipsește)
- **SQLite 3**: Pentru stocare persistentă (inclus)

---

## Configurare

Setările sunt gestionate în `~/.claude-mem/settings.json` (creat automat cu valori implicite la prima rulare). Configurați modelul AI, portul worker, directorul de date, nivelul de log și setările de injectare a contextului.

Consultați **[Ghidul de Configurare](https://docs.claude-mem.ai/configuration)** pentru toate setările disponibile și exemple.

---

## Dezvoltare

Consultați **[Ghidul de Dezvoltare](https://docs.claude-mem.ai/development)** pentru instrucțiuni de construire, testare și flux de contribuție.

---

## Depanare

Dacă întâmpinați probleme, descrieți problema lui Claude și abilitatea troubleshoot va diagnostica automat și va furniza soluții.

Consultați **[Ghidul de Depanare](https://docs.claude-mem.ai/troubleshooting)** pentru probleme comune și soluții.

---

## Rapoarte de Bug-uri

Creați rapoarte comprehensive de bug-uri cu generatorul automat:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Contribuție

Contribuțiile sunt binevenite! Vă rugăm:

1. Faceți fork la repository
2. Creați o ramură de funcție
3. Faceți modificările cu teste
4. Actualizați documentația
5. Trimiteți un Pull Request

Consultați [Ghidul de Dezvoltare](https://docs.claude-mem.ai/development) pentru fluxul de contribuție.

---

## License

This project is licensed under the **Apache License 2.0** (Apache-2.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

Apache-2.0 allows broad use, modification, distribution, and commercial use, subject to its terms.

**Ragtime note**: The ragtime/ directory is licensed under the **Apache License 2.0**. See [ragtime/LICENSE](ragtime/LICENSE) for details.

---


## Suport

- **Documentație**: [docs/](docs/)
- **Probleme**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Autor**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Construit cu Claude Agent SDK** | **Alimentat de Claude Code** | **Realizat cu TypeScript**