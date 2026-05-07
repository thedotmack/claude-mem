🌐 Toto je automatický překlad. Komunitní opravy jsou vítány!

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

<h4 align="center">Systém trvalé komprese paměti vytvořený pro <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#rychlý-start">Rychlý start</a> •
  <a href="#jak-to-funguje">Jak to funguje</a> •
  <a href="#vyhledávací-nástroje-mcp">Vyhledávací nástroje</a> •
  <a href="#dokumentace">Dokumentace</a> •
  <a href="#konfigurace">Konfigurace</a> •
  <a href="#řešení-problémů">Řešení problémů</a> •
  <a href="#licence">Licence</a>
</p>

<p align="center">
  Claude-Mem bezproblémově zachovává kontext napříč sezeními tím, že automaticky zaznamenává pozorování použití nástrojů, generuje sémantické souhrny a zpřístupňuje je budoucím sezením. To umožňuje Claude udržovat kontinuitu znalostí o projektech i po ukončení nebo opětovném připojení sezení.
</p>

---

## Rychlý start

Spusťte nové sezení Claude Code v terminálu a zadejte následující příkazy:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Restartujte Claude Code. Kontext z předchozích sezení se automaticky objeví v nových sezeních.

**Klíčové vlastnosti:**

- 🧠 **Trvalá paměť** - Kontext přetrvává napříč sezeními
- 📊 **Postupné odhalování** - Vrstvené vyhledávání paměti s viditelností nákladů na tokeny
- 🔍 **Vyhledávání založené na dovednostech** - Dotazujte se na historii projektu pomocí dovednosti mem-search
- 🖥️ **Webové uživatelské rozhraní** - Tok paměti v reálném čase na http://localhost:37777
- 💻 **Dovednost pro Claude Desktop** - Vyhledávejte v paměti z konverzací Claude Desktop
- 🔒 **Kontrola soukromí** - Použijte značky `<private>` k vyloučení citlivého obsahu z úložiště
- ⚙️ **Konfigurace kontextu** - Jemně odstupňovaná kontrola nad tím, jaký kontext se vkládá
- 🤖 **Automatický provoz** - Není vyžadován žádný manuální zásah
- 🔗 **Citace** - Odkazujte na minulá pozorování pomocí ID (přístup přes http://localhost:37777/api/observation/{id} nebo zobrazit vše ve webovém prohlížeči na http://localhost:37777)
- 🧪 **Beta kanál** - Vyzkoušejte experimentální funkce jako Endless Mode přepnutím verze

---

## Dokumentace

📚 **[Zobrazit kompletní dokumentaci](https://docs.claude-mem.ai/)** - Procházet na oficiálních stránkách

### Začínáme

- **[Průvodce instalací](https://docs.claude-mem.ai/installation)** - Rychlý start a pokročilá instalace
- **[Průvodce použitím](https://docs.claude-mem.ai/usage/getting-started)** - Jak Claude-Mem funguje automaticky
- **[Vyhledávací nástroje](https://docs.claude-mem.ai/usage/search-tools)** - Dotazujte se na historii projektu pomocí přirozeného jazyka
- **[Beta funkce](https://docs.claude-mem.ai/beta-features)** - Vyzkoušejte experimentální funkce jako Endless Mode

### Osvědčené postupy

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - Principy optimalizace kontextu AI agenta
- **[Postupné odhalování](https://docs.claude-mem.ai/progressive-disclosure)** - Filozofie strategie přípravy kontextu Claude-Mem

### Architektura

- **[Přehled](https://docs.claude-mem.ai/architecture/overview)** - Systémové komponenty a tok dat
- **[Evoluce architektury](https://docs.claude-mem.ai/architecture-evolution)** - Cesta z v3 na v5
- **[Architektura háčků](https://docs.claude-mem.ai/hooks-architecture)** - Jak Claude-Mem používá lifecycle hooks
- **[Reference háčků](https://docs.claude-mem.ai/architecture/hooks)** - Vysvětlení 7 hook skriptů
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API a správa Bun
- **[Databáze](https://docs.claude-mem.ai/architecture/database)** - SQLite schéma a FTS5 vyhledávání
- **[Architektura vyhledávání](https://docs.claude-mem.ai/architecture/search-architecture)** - Hybridní vyhledávání s vektorovou databází Chroma

### Konfigurace a vývoj

- **[Konfigurace](https://docs.claude-mem.ai/configuration)** - Proměnné prostředí a nastavení
- **[Vývoj](https://docs.claude-mem.ai/development)** - Sestavení, testování, přispívání
- **[Řešení problémů](https://docs.claude-mem.ai/troubleshooting)** - Běžné problémy a řešení

---

## Jak to funguje

**Hlavní komponenty:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook skriptů)
2. **Chytrá instalace** - Kontrola cachovaných závislostí (pre-hook skript, ne lifecycle hook)
3. **Worker Service** - HTTP API na portu 37777 s webovým prohlížečem a 10 vyhledávacími endpointy, spravováno pomocí Bun
4. **SQLite databáze** - Ukládá sezení, pozorování, souhrny
5. **mem-search dovednost** - Dotazy v přirozeném jazyce s postupným odhalováním
6. **Chroma vektorová databáze** - Hybridní sémantické + klíčové vyhledávání pro inteligentní vyhledávání kontextu

Podrobnosti najdete v [Přehledu architektury](https://docs.claude-mem.ai/architecture/overview).

---

## Dovednost mem-search

Claude-Mem poskytuje inteligentní vyhledávání prostřednictvím dovednosti mem-search, která se automaticky vyvolá, když se ptáte na minulou práci:

**Jak to funguje:**
- Stačí se zeptat přirozeně: *"Co jsme dělali minulé sezení?"* nebo *"Opravovali jsme tuto chybu dříve?"*
- Claude automaticky vyvolá dovednost mem-search k nalezení relevantního kontextu

**Dostupné vyhledávací operace:**

1. **Search Observations** - Fulltextové vyhledávání napříč pozorováními
2. **Search Sessions** - Fulltextové vyhledávání napříč souhrny sezení
3. **Search Prompts** - Vyhledávání surových požadavků uživatelů
4. **By Concept** - Hledání podle koncepčních značek (discovery, problem-solution, pattern, atd.)
5. **By File** - Hledání pozorování odkazujících na konkrétní soubory
6. **By Type** - Hledání podle typu (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Získání nedávného kontextu sezení pro projekt
8. **Timeline** - Získání jednotné časové osy kontextu kolem konkrétního bodu v čase
9. **Timeline by Query** - Vyhledávání pozorování a získání kontextu časové osy kolem nejlepší shody
10. **API Help** - Získání dokumentace k vyhledávacímu API

**Příklady dotazů v přirozeném jazyce:**

```
"Jaké chyby jsme opravili minulé sezení?"
"Jak jsme implementovali autentizaci?"
"Jaké změny byly provedeny v worker-service.ts?"
"Ukaž mi nedávnou práci na tomto projektu"
"Co se dělo, když jsme přidávali viewer UI?"
```

Podrobné příklady najdete v [Průvodci vyhledávacími nástroji](https://docs.claude-mem.ai/usage/search-tools).

---

## Beta funkce

Claude-Mem nabízí **beta kanál** s experimentálními funkcemi jako **Endless Mode** (biomimetická architektura paměti pro prodloužená sezení). Přepínejte mezi stabilní a beta verzí z webového rozhraní na http://localhost:37777 → Settings.

Podrobnosti o Endless Mode a jak jej vyzkoušet najdete v **[Dokumentaci beta funkcí](https://docs.claude-mem.ai/beta-features)**.

---

## Systémové požadavky

- **Node.js**: 18.0.0 nebo vyšší
- **Claude Code**: Nejnovější verze s podporou pluginů
- **Bun**: JavaScript runtime a správce procesů (automaticky nainstalován, pokud chybí)
- **uv**: Python správce balíčků pro vektorové vyhledávání (automaticky nainstalován, pokud chybí)
- **SQLite 3**: Pro trvalé úložiště (součástí balíčku)

---

## Konfigurace

Nastavení jsou spravována v `~/.claude-mem/settings.json` (automaticky vytvořeno s výchozími hodnotami při prvním spuštění). Konfigurujte AI model, port workeru, datový adresář, úroveň logování a nastavení vkládání kontextu.

Všechna dostupná nastavení a příklady najdete v **[Průvodci konfigurací](https://docs.claude-mem.ai/configuration)**.

---

## Vývoj

Podrobné pokyny k sestavení, testování a pracovnímu postupu pro přispívání najdete v **[Průvodci vývojem](https://docs.claude-mem.ai/development)**.

---

## Řešení problémů

Pokud zaznamenáváte problémy, popište problém Claude a dovednost troubleshoot automaticky diagnostikuje a poskytne opravy.

Běžné problémy a řešení najdete v **[Průvodci řešením problémů](https://docs.claude-mem.ai/troubleshooting)**.

---

## Hlášení chyb

Vytvořte komplexní hlášení chyby pomocí automatického generátoru:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Přispívání

Příspěvky jsou vítány! Prosím:

1. Forkněte repositář
2. Vytvořte feature branch
3. Proveďte změny s testy
4. Aktualizujte dokumentaci
5. Odešlete Pull Request

Pracovní postup pro přispívání najdete v [Průvodci vývojem](https://docs.claude-mem.ai/development).

---

## License

This project is licensed under the **Apache License 2.0** (Apache-2.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

Apache-2.0 allows broad use, modification, distribution, and commercial use, subject to its terms.

**Ragtime note**: The ragtime/ directory is licensed under the **Apache License 2.0**. See [ragtime/LICENSE](ragtime/LICENSE) for details.

---


## Podpora

- **Dokumentace**: [docs/](docs/)
- **Problémy**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repositář**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Autor**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Vytvořeno pomocí Claude Agent SDK** | **Poháněno Claude Code** | **Vyrobeno s TypeScript**

---