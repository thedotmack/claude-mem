🌐 Toto je automatický překlad. Opravy od komunity jsou vítány!

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

<h4 align="center">Systém trvalé komprese paměti vytvořený pro <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#rychlý-start">Rychlý start</a> •
  <a href="#jak-to-funguje">Jak to funguje</a> •
  <a href="#vyhledávací-nástroje-mcp">Vyhledávací nástroje</a> •
  <a href="#dokumentace">Dokumentace</a> •
  <a href="#konfigurace">Konfigurace</a> •
  <a href="#řešení-problémů">Řešení problémů</a> •
  <a href="#licence">Licence</a>
</p>

<p align="center">
  Claude-Mem plynule uchovává kontext napříč relacemi automatickým zachycováním pozorování z používání nástrojů, generováním sémantických souhrnů a jejich zpřístupněním budoucím relacím. To umožňuje Claude udržovat kontinuitu znalostí o projektech i po ukončení nebo opětovném připojení relací.
</p>

---

## Rychlý start

Spusťte novou relaci Claude Code v terminálu a zadejte následující příkazy:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Restartujte Claude Code. Kontext z předchozích relací se automaticky objeví v nových relacích.

**Klíčové vlastnosti:**

- 🧠 **Trvalá paměť** - Kontext přežívá napříč relacemi
- 📊 **Postupné odhalování** - Vrstvené načítání paměti s viditelností tokenových nákladů
- 🔍 **Vyhledávání založené na dovednostech** - Dotazujte se na historii projektu pomocí dovednosti mem-search (~2 250 tokenů úspory)
- 🖥️ **Webové rozhraní prohlížeče** - Stream paměti v reálném čase na http://localhost:37777
- 🔒 **Kontrola soukromí** - Použijte značky `<private>` k vyloučení citlivého obsahu z úložiště
- ⚙️ **Konfigurace kontextu** - Jemná kontrola nad tím, jaký kontext se vkládá
- 🤖 **Automatický provoz** - Není vyžadován žádný manuální zásah
- 🔗 **Citace** - Odkazy na minulá rozhodnutí pomocí URI `claude-mem://`
- 🧪 **Beta kanál** - Vyzkoušejte experimentální funkce jako Endless Mode přepínáním verzí

---

## Dokumentace

📚 **[Zobrazit úplnou dokumentaci](docs/)** - Procházet markdown dokumenty na GitHubu

💻 **Lokální náhled**: Spusťte Mintlify dokumenty lokálně:

```bash
cd docs
npx mintlify dev
```

### Začínáme

- **[Průvodce instalací](https://docs.claude-mem.ai/installation)** - Rychlý start a pokročilá instalace
- **[Průvodce používáním](https://docs.claude-mem.ai/usage/getting-started)** - Jak Claude-Mem funguje automaticky
- **[Vyhledávací nástroje](https://docs.claude-mem.ai/usage/search-tools)** - Dotazujte se na historii projektu přirozeným jazykem
- **[Beta funkce](https://docs.claude-mem.ai/beta-features)** - Vyzkoušejte experimentální funkce jako Endless Mode

### Osvědčené postupy

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - Principy optimalizace kontextu AI agenta
- **[Postupné odhalování](https://docs.claude-mem.ai/progressive-disclosure)** - Filozofie za strategií primingu kontextu Claude-Mem

### Architektura

- **[Přehled](https://docs.claude-mem.ai/architecture/overview)** - Komponenty systému a tok dat
- **[Evoluce architektury](https://docs.claude-mem.ai/architecture-evolution)** - Cesta od v3 k v5
- **[Architektura háčků](https://docs.claude-mem.ai/hooks-architecture)** - Jak Claude-Mem používá lifecycle hooks
- **[Reference háčků](https://docs.claude-mem.ai/architecture/hooks)** - 7 hook skriptů vysvětleno
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API a PM2 management
- **[Databáze](https://docs.claude-mem.ai/architecture/database)** - SQLite schéma a FTS5 vyhledávání
- **[Architektura vyhledávání](https://docs.claude-mem.ai/architecture/search-architecture)** - Hybridní vyhledávání s vektorovou databází Chroma

### Konfigurace a vývoj

- **[Konfigurace](https://docs.claude-mem.ai/configuration)** - Proměnné prostředí a nastavení
- **[Vývoj](https://docs.claude-mem.ai/development)** - Sestavení, testování, přispívání
- **[Řešení problémů](https://docs.claude-mem.ai/troubleshooting)** - Běžné problémy a řešení

---

## Jak to funguje

```
┌─────────────────────────────────────────────────────────────┐
│ Začátek relace → Vložit nedávná pozorování jako kontext     │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Uživatelské výzvy → Vytvořit relaci, uložit výzvy          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Spuštění nástrojů → Zachytit pozorování (Read, Write atd.) │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Worker procesy → Extrahovat poznatky přes Claude Agent SDK  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Konec relace → Vygenerovat souhrn, připravit další relaci  │
└─────────────────────────────────────────────────────────────┘
```

**Hlavní komponenty:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook skriptů)
2. **Smart Install** - Cache kontrola závislostí (pre-hook skript, ne lifecycle hook)
3. **Worker Service** - HTTP API na portu 37777 s webovým rozhraním prohlížeče a 10 vyhledávacími endpointy, spravováno PM2
4. **SQLite databáze** - Ukládá relace, pozorování, souhrny s FTS5 fulltextovým vyhledáváním
5. **mem-search dovednost** - Dotazy v přirozeném jazyce s postupným odhalováním (~2 250 tokenů úspory vs MCP)
6. **Chroma vektorová databáze** - Hybridní sémantické + klíčové vyhledávání pro inteligentní načítání kontextu

Viz [Přehled architektury](https://docs.claude-mem.ai/architecture/overview) pro podrobnosti.

---

## Dovednost mem-search

Claude-Mem poskytuje inteligentní vyhledávání prostřednictvím dovednosti mem-search, která se automaticky spouští, když se ptáte na minulou práci:

**Jak to funguje:**
- Jen se ptejte přirozeně: *"Co jsme dělali minulou relaci?"* nebo *"Opravovali jsme tento bug předtím?"*
- Claude automaticky vyvolá dovednost mem-search k nalezení relevantního kontextu
- ~2 250 tokenů úspory na začátku relace vs přístup MCP

**Dostupné vyhledávací operace:**

1. **Vyhledávání pozorování** - Fulltextové vyhledávání napříč pozorováními
2. **Vyhledávání relací** - Fulltextové vyhledávání napříč souhrny relací
3. **Vyhledávání výzev** - Vyhledávání v původních uživatelských požadavcích
4. **Podle konceptu** - Najít podle konceptových tagů (discovery, problem-solution, pattern atd.)
5. **Podle souboru** - Najít pozorování odkazující na konkrétní soubory
6. **Podle typu** - Najít podle typu (decision, bugfix, feature, refactor, discovery, change)
7. **Nedávný kontext** - Získat nedávný kontext relace pro projekt
8. **Časová osa** - Získat jednotnou časovou osu kontextu kolem konkrétního bodu v čase
9. **Časová osa podle dotazu** - Vyhledat pozorování a získat kontext časové osy kolem nejlepší shody
10. **Nápověda API** - Získat dokumentaci vyhledávacího API

**Příklady dotazů v přirozeném jazyce:**

```
"Jaké bugy jsme opravili minulou relaci?"
"Jak jsme implementovali autentizaci?"
"Jaké změny byly provedeny v worker-service.ts?"
"Ukaž mi nedávnou práci na tomto projektu"
"Co se dělo, když jsme přidávali viewer UI?"
```

Viz [Průvodce vyhledávacími nástroji](https://docs.claude-mem.ai/usage/search-tools) pro podrobné příklady.

---

## Beta funkce a Endless Mode

Claude-Mem nabízí **beta kanál** s experimentálními funkcemi. Přepínejte mezi stabilními a beta verzemi přímo z webového rozhraní prohlížeče.

### Jak vyzkoušet Beta

1. Otevřete http://localhost:37777
2. Klikněte na Nastavení (ikona ozubeného kola)
3. V **Version Channel** klikněte na "Try Beta (Endless Mode)"
4. Počkejte na restart workera

Vaše data paměti jsou zachována při přepínání verzí.

### Endless Mode (Beta)

Vlajková beta funkce je **Endless Mode** - biomimetická architektura paměti, která dramaticky prodlužuje délku relace:

**Problém**: Standardní relace Claude Code dosáhnou limitů kontextu po ~50 použitích nástrojů. Každý nástroj přidá 1-10k+ tokenů a Claude re-syntetizuje všechny předchozí výstupy při každé odpovědi (složitost O(N²)).

**Řešení**: Endless Mode komprimuje výstupy nástrojů do ~500-tokenových pozorování a transformuje transkript v reálném čase:

```
Pracovní paměť (kontext):     Komprimovaná pozorování (~500 tokenů každé)
Archivní paměť (disk):        Úplné výstupy nástrojů zachované pro vyvolání
```

**Očekávané výsledky**:
- ~95% redukce tokenů v kontextovém okně
- ~20x více použití nástrojů před vyčerpáním kontextu
- Lineární škálování O(N) místo kvadratického O(N²)
- Úplné transkripty zachované pro dokonalé vyvolání

**Upozornění**: Přidává latenci (60-90s na nástroj pro generování pozorování), stále experimentální.

Viz [Dokumentace beta funkcí](https://docs.claude-mem.ai/beta-features) pro podrobnosti.

---

## Co je nového

**v6.4.9 - Nastavení konfigurace kontextu:**
- 11 nových nastavení pro jemnou kontrolu nad vkládáním kontextu
- Konfigurujte zobrazení tokenové ekonomiky, filtrování pozorování podle typu/konceptu
- Kontrolujte počet pozorování a která pole zobrazit

**v6.4.0 - Dual-Tag systém ochrany soukromí:**
- Značky `<private>` pro uživatelem řízenou ochranu soukromí - zabalte citlivý obsah k vyloučení z úložiště
- Systémové značky `<claude-mem-context>` zabraňují rekurzivnímu ukládání pozorování
- Edge zpracování zajišťuje, že soukromý obsah nikdy nedosáhne databáze

**v6.3.0 - Kanál verzí:**
- Přepínejte mezi stabilními a beta verzemi z webového rozhraní prohlížeče
- Vyzkoušejte experimentální funkce jako Endless Mode bez manuálních git operací

**Předchozí zajímavosti:**
- **v6.0.0**: Významná vylepšení správy relací a zpracování transkriptů
- **v5.5.0**: Vylepšení dovednosti mem-search s 100% efektivitou
- **v5.4.0**: Architektura vyhledávání založená na dovednostech (~2 250 tokenů uloženo na relaci)
- **v5.1.0**: Webové rozhraní prohlížeče s aktualizacemi v reálném čase
- **v5.0.0**: Hybridní vyhledávání s vektorovou databází Chroma

Viz [CHANGELOG.md](CHANGELOG.md) pro kompletní historii verzí.

---

## Systémové požadavky

- **Node.js**: 18.0.0 nebo vyšší
- **Claude Code**: Nejnovější verze s podporou pluginů
- **PM2**: Správce procesů (v balíčku - není vyžadována globální instalace)
- **SQLite 3**: Pro trvalé úložiště (v balíčku)

---

## Klíčové výhody

### Kontext postupného odhalování

- **Vrstvené načítání paměti** zrcadlí vzorce lidské paměti
- **Vrstva 1 (Index)**: Zobrazit, jaká pozorování existují s tokenovými náklady na začátku relace
- **Vrstva 2 (Detaily)**: Načíst úplné popisy na vyžádání přes MCP vyhledávání
- **Vrstva 3 (Dokonalé vyvolání)**: Přístup ke zdrojovému kódu a původním transkriptům
- **Chytré rozhodování**: Počty tokenů pomáhají Claude vybrat mezi načítáním detailů nebo čtením kódu
- **Indikátory typu**: Vizuální vodítka (🔴 kritické, 🟤 rozhodnutí, 🔵 informační) zvýrazňují důležitost pozorování

### Automatická paměť

- Kontext automaticky vložen při spuštění Claude
- Nejsou potřeba žádné manuální příkazy nebo konfigurace
- Funguje transparentně na pozadí

### Vyhledávání v úplné historii

- Vyhledávání napříč všemi relacemi a pozorováními
- FTS5 fulltextové vyhledávání pro rychlé dotazy
- Citace odkazují zpět na konkrétní pozorování

### Strukturovaná pozorování

- AI-powered extrakce poznatků
- Kategorizováno podle typu (decision, bugfix, feature atd.)
- Označeno koncepty a odkazy na soubory

### Multi-promptové relace

- Relace pokrývají více uživatelských výzev
- Kontext zachován napříč příkazy `/clear`
- Sledování celých konverzačních vláken

---

## Konfigurace

Nastavení jsou spravována v `~/.claude-mem/settings.json`. Soubor je automaticky vytvořen s výchozími hodnotami při prvním spuštění.

**Dostupná nastavení:**

| Nastavení | Výchozí | Popis |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | AI model pro pozorování |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | Port worker service |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | Umístění datového adresáře |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | Podrobnost logování (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | Verze Pythonu pro chroma-mcp |
| `CLAUDE_CODE_PATH` | _(auto-detect)_ | Cesta k spustitelnému souboru Claude |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Počet pozorování k vložení při SessionStart |

**Správa nastavení:**

```bash
# Upravit nastavení přes CLI helper
./claude-mem-settings.sh

# Nebo upravit přímo
nano ~/.claude-mem/settings.json

# Zobrazit aktuální nastavení
curl http://localhost:37777/api/settings
```

**Formát souboru nastavení:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

Viz [Průvodce konfigurací](https://docs.claude-mem.ai/configuration) pro podrobnosti.

---

## Vývoj

```bash
# Klonovat a sestavit
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# Spustit testy
npm test

# Spustit worker
npm run worker:start

# Zobrazit logy
npm run worker:logs
```

Viz [Průvodce vývojem](https://docs.claude-mem.ai/development) pro podrobné instrukce.

---

## Řešení problémů

**Rychlá diagnostika:**

Pokud máte problémy, popište problém Claude a dovednost troubleshoot se automaticky aktivuje k diagnostice a poskytne opravy.

**Běžné problémy:**

- Worker se nespouští → `npm run worker:restart`
- Neobjevuje se kontext → `npm run test:context`
- Problémy s databází → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Vyhledávání nefunguje → Zkontrolujte, zda existují FTS5 tabulky

Viz [Průvodce řešením problémů](https://docs.claude-mem.ai/troubleshooting) pro kompletní řešení.

---

## Přispívání

Příspěvky jsou vítány! Prosím:

1. Forkněte repozitář
2. Vytvořte feature branch
3. Proveďte změny s testy
4. Aktualizujte dokumentaci
5. Odešlete Pull Request

Viz [Průvodce vývojem](https://docs.claude-mem.ai/development) pro workflow přispívání.

---

## Licence

Tento projekt je licencován pod **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Všechna práva vyhrazena.

Viz soubor [LICENSE](LICENSE) pro úplné detaily.

**Co to znamená:**

- Můžete tento software volně používat, upravovat a distribuovat
- Pokud upravíte a nasadíte na síťový server, musíte zpřístupnit svůj zdrojový kód
- Odvozená díla musí být také licencována pod AGPL-3.0
- Pro tento software neexistuje ŽÁDNÁ ZÁRUKA

---

## Podpora

- **Dokumentace**: [docs/](docs/)
- **Problémy**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repozitář**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Autor**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Postaveno s Claude Agent SDK** | **Poháněno Claude Code** | **Vytvořeno s TypeScript**