🌐 Aceasta este o traducere automată. Corecțiile din partea comunității sunt bine-venite!

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

<h4 align="center">Sistem persistent de compresie a memoriei construit pentru <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#start-rapid">Start Rapid</a> •
  <a href="#cum-funcționează">Cum Funcționează</a> •
  <a href="#instrumente-de-căutare-mcp">Instrumente de Căutare</a> •
  <a href="#documentație">Documentație</a> •
  <a href="#configurare">Configurare</a> •
  <a href="#depanare">Depanare</a> •
  <a href="#licență">Licență</a>
</p>

<p align="center">
  Claude-Mem păstrează cu ușurință contextul între sesiuni prin captarea automată a observațiilor de utilizare a instrumentelor, generarea de rezumate semantice și punerea lor la dispoziție pentru sesiunile viitoare. Acest lucru permite lui Claude să mențină continuitatea cunoștințelor despre proiecte chiar și după ce sesiunile se încheie sau se reconectează.
</p>

---

## Start Rapid

Începeți o nouă sesiune Claude Code în terminal și introduceți următoarele comenzi:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Reporniți Claude Code. Contextul din sesiunile anterioare va apărea automat în sesiunile noi.

**Caracteristici Cheie:**

- 🧠 **Memorie Persistentă** - Contextul supraviețuiește între sesiuni
- 📊 **Dezvăluire Progresivă** - Recuperare stratificată a memoriei cu vizibilitatea costului în tokeni
- 🔍 **Căutare Bazată pe Abilități** - Interogați istoricul proiectului cu abilitatea mem-search (~2.250 tokeni economisiți)
- 🖥️ **Interfață Web Viewer** - Flux de memorie în timp real la http://localhost:37777
- 🔒 **Control al Confidențialității** - Utilizați tag-uri `<private>` pentru a exclude conținutul sensibil din stocare
- ⚙️ **Configurare Context** - Control precis asupra contextului injectat
- 🤖 **Operare Automată** - Nu necesită intervenție manuală
- 🔗 **Citări** - Referențiați decizii anterioare cu URI-uri `claude-mem://`
- 🧪 **Canal Beta** - Încercați funcții experimentale precum Modul Nesfârșit prin schimbarea versiunii

---

## Documentație

📚 **[Vizualizați Documentația Completă](docs/)** - Răsfoiți documentația markdown pe GitHub

💻 **Previzualizare Locală**: Rulați documentația Mintlify local:

```bash
cd docs
npx mintlify dev
```

### Noțiuni de Bază

- **[Ghid de Instalare](https://docs.claude-mem.ai/installation)** - Start rapid & instalare avansată
- **[Ghid de Utilizare](https://docs.claude-mem.ai/usage/getting-started)** - Cum funcționează Claude-Mem automat
- **[Instrumente de Căutare](https://docs.claude-mem.ai/usage/search-tools)** - Interogați istoricul proiectului cu limbaj natural
- **[Funcții Beta](https://docs.claude-mem.ai/beta-features)** - Încercați funcții experimentale precum Modul Nesfârșit

### Cele Mai Bune Practici

- **[Ingineria Contextului](https://docs.claude-mem.ai/context-engineering)** - Principii de optimizare a contextului pentru agenți AI
- **[Dezvăluire Progresivă](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofia din spatele strategiei de pregătire a contextului Claude-Mem

### Arhitectură

- **[Prezentare Generală](https://docs.claude-mem.ai/architecture/overview)** - Componente sistem & flux de date
- **[Evoluția Arhitecturii](https://docs.claude-mem.ai/architecture-evolution)** - Călătoria de la v3 la v5
- **[Arhitectura Hook-urilor](https://docs.claude-mem.ai/hooks-architecture)** - Cum folosește Claude-Mem hook-uri de ciclu de viață
- **[Referință Hook-uri](https://docs.claude-mem.ai/architecture/hooks)** - 7 scripturi hook explicate
- **[Serviciu Worker](https://docs.claude-mem.ai/architecture/worker-service)** - API HTTP & management PM2
- **[Bază de Date](https://docs.claude-mem.ai/architecture/database)** - Schemă SQLite & căutare FTS5
- **[Arhitectura Căutării](https://docs.claude-mem.ai/architecture/search-architecture)** - Căutare hibridă cu bază de date vectorială Chroma

### Configurare & Dezvoltare

- **[Configurare](https://docs.claude-mem.ai/configuration)** - Variabile de mediu & setări
- **[Dezvoltare](https://docs.claude-mem.ai/development)** - Construire, testare, contribuire
- **[Depanare](https://docs.claude-mem.ai/troubleshooting)** - Probleme comune & soluții

---

## Cum Funcționează

```
┌─────────────────────────────────────────────────────────────┐
│ Start Sesiune → Injectează observații recente ca context   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Prompturi Utilizator → Creează sesiune, salvează prompturi │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Execuții Instrumente → Capturează observații (Read, Write) │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Procese Worker → Extrage învățăminte via Claude Agent SDK  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Sfârșit Sesiune → Generează rezumat, gata pt. următoarea  │
└─────────────────────────────────────────────────────────────┘
```

**Componente de Bază:**

1. **5 Hook-uri de Ciclu de Viață** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 scripturi hook)
2. **Instalare Inteligentă** - Verificator de dependențe cu cache (script pre-hook, nu un hook de ciclu de viață)
3. **Serviciu Worker** - API HTTP pe portul 37777 cu interfață web viewer și 10 endpoint-uri de căutare, gestionat de PM2
4. **Bază de Date SQLite** - Stochează sesiuni, observații, rezumate cu căutare full-text FTS5
5. **Abilitatea mem-search** - Interogări în limbaj natural cu dezvăluire progresivă (~2.250 tokeni economisiți vs MCP)
6. **Bază de Date Vectorială Chroma** - Căutare hibridă semantică + cuvinte cheie pentru recuperare inteligentă a contextului

Vedeți [Prezentarea Generală a Arhitecturii](https://docs.claude-mem.ai/architecture/overview) pentru detalii.

---

## Abilitatea mem-search

Claude-Mem oferă căutare inteligentă prin abilitatea mem-search care se auto-invocă când întrebați despre munca anterioară:

**Cum Funcționează:**
- Întrebați pur și simplu natural: *"Ce am făcut în sesiunea trecută?"* sau *"Am rezolvat acest bug înainte?"*
- Claude invocă automat abilitatea mem-search pentru a găsi contextul relevant
- ~2.250 tokeni economisiți per start de sesiune vs abordarea MCP

**Operații de Căutare Disponibile:**

1. **Căutare Observații** - Căutare full-text în observații
2. **Căutare Sesiuni** - Căutare full-text în rezumatele sesiunilor
3. **Căutare Prompturi** - Căutare în cererile brute ale utilizatorului
4. **După Concept** - Găsire după tag-uri de concept (discovery, problem-solution, pattern, etc.)
5. **După Fișier** - Găsire observații care referențiază fișiere specifice
6. **După Tip** - Găsire după tip (decision, bugfix, feature, refactor, discovery, change)
7. **Context Recent** - Obținere context recent de sesiune pentru un proiect
8. **Cronologie** - Obținere cronologie unificată a contextului în jurul unui punct specific în timp
9. **Cronologie după Interogare** - Căutare observații și obținere context cronologic în jurul celei mai bune potriviri
10. **Ajutor API** - Obținere documentație API de căutare

**Exemple de Interogări în Limbaj Natural:**

```
"Ce bug-uri am rezolvat în sesiunea trecută?"
"Cum am implementat autentificarea?"
"Ce modificări au fost făcute în worker-service.ts?"
"Arată-mi munca recentă la acest proiect"
"Ce se întâmpla când am adăugat interfața viewer?"
```

Vedeți [Ghidul Instrumentelor de Căutare](https://docs.claude-mem.ai/usage/search-tools) pentru exemple detaliate.

---

## Funcții Beta & Modul Nesfârșit

Claude-Mem oferă un **canal beta** cu funcții experimentale. Schimbați între versiunile stabile și beta direct din interfața web viewer.

### Cum să Încercați Beta

1. Deschideți http://localhost:37777
2. Faceți clic pe Settings (iconița roată dințată)
3. În **Version Channel**, faceți clic pe "Try Beta (Endless Mode)"
4. Așteptați ca worker-ul să repornească

Datele de memorie sunt păstrate când schimbați versiunile.

### Modul Nesfârșit (Beta)

Funcția beta principală este **Modul Nesfârșit** - o arhitectură de memorie biomimetică care extinde dramatic lungimea sesiunii:

**Problema**: Sesiunile standard Claude Code ating limite de context după ~50 de utilizări de instrumente. Fiecare instrument adaugă 1-10k+ tokeni, iar Claude re-sintetizează toate output-urile anterioare la fiecare răspuns (complexitate O(N²)).

**Soluția**: Modul Nesfârșit comprimă output-urile instrumentelor în observații de ~500 tokeni și transformă transcrierea în timp real:

```
Memorie de Lucru (Context):   Observații comprimate (~500 tokeni fiecare)
Memorie Arhivă (Disc):        Output-uri complete ale instrumentelor păstrate pentru recuperare
```

**Rezultate Așteptate**:
- ~95% reducere tokeni în fereastra de context
- ~20x mai multe utilizări de instrumente înainte de epuizarea contextului
- Scalare liniară O(N) în loc de pătratică O(N²)
- Transcrieri complete păstrate pentru recuperare perfectă

**Avertismente**: Adaugă latență (60-90s per instrument pentru generarea observațiilor), încă experimental.

Vedeți [Documentația Funcțiilor Beta](https://docs.claude-mem.ai/beta-features) pentru detalii.

---

## Ce e Nou

**v6.4.9 - Setări de Configurare Context:**
- 11 setări noi pentru control precis asupra injecției de context
- Configurați afișarea economiei de tokeni, filtrarea observațiilor după tip/concept
- Controlați numărul de observații și ce câmpuri să fie afișate

**v6.4.0 - Sistem de Confidențialitate cu Două Tag-uri:**
- Tag-uri `<private>` pentru confidențialitate controlată de utilizator - înfășurați conținut sensibil pentru a-l exclude din stocare
- Tag-uri `<claude-mem-context>` la nivel de sistem previn stocarea recursivă a observațiilor
- Procesarea la margine asigură că conținutul privat nu ajunge niciodată în baza de date

**v6.3.0 - Canal de Versiuni:**
- Schimbați între versiunile stabile și beta din interfața web viewer
- Încercați funcții experimentale precum Modul Nesfârșit fără operații git manuale

**Puncte Importante Anterioare:**
- **v6.0.0**: Îmbunătățiri majore ale managementului sesiunilor & procesării transcrierilor
- **v5.5.0**: Îmbunătățirea abilității mem-search cu rată de eficiență 100%
- **v5.4.0**: Arhitectură de căutare bazată pe abilități (~2.250 tokeni economisiți per sesiune)
- **v5.1.0**: Interfață viewer bazată pe web cu actualizări în timp real
- **v5.0.0**: Căutare hibridă cu bază de date vectorială Chroma

Vedeți [CHANGELOG.md](CHANGELOG.md) pentru istoricul complet al versiunilor.

---

## Cerințe de Sistem

- **Node.js**: 18.0.0 sau mai nou
- **Claude Code**: Ultima versiune cu suport pentru plugin-uri
- **PM2**: Manager de procese (inclus - nu necesită instalare globală)
- **SQLite 3**: Pentru stocare persistentă (inclus)

---

## Beneficii Cheie

### Context cu Dezvăluire Progresivă

- **Recuperarea stratificată a memoriei** reflectă modelele de memorie umană
- **Stratul 1 (Index)**: Vedeți ce observații există cu costuri în tokeni la începutul sesiunii
- **Stratul 2 (Detalii)**: Preluați narațiuni complete la cerere via căutare MCP
- **Stratul 3 (Recuperare Perfectă)**: Accesați codul sursă și transcrierile originale
- **Luare de decizie inteligentă**: Numărul de tokeni ajută Claude să aleagă între preluarea de detalii sau citirea codului
- **Indicatori de tip**: Indicii vizuale (🔴 critic, 🟤 decizie, 🔵 informațional) evidențiază importanța observațiilor

### Memorie Automată

- Context injectat automat când Claude pornește
- Nu necesită comenzi manuale sau configurare
- Funcționează transparent în fundal

### Căutare în Istoric Complet

- Căutare în toate sesiunile și observațiile
- Căutare full-text FTS5 pentru interogări rapide
- Citările se leagă înapoi la observații specifice

### Observații Structurate

- Extracție a învățămintelor alimentată de AI
- Categorizate după tip (decizie, bugfix, funcționalitate, etc.)
- Etichetate cu concepte și referințe de fișiere

### Sesiuni Multi-Prompt

- Sesiunile acoperă multiple prompturi ale utilizatorului
- Context păstrat între comenzile `/clear`
- Urmărire întreaga conversație

---

## Configurare

Setările sunt gestionate în `~/.claude-mem/settings.json`. Fișierul este creat automat cu valorile implicite la prima rulare.

**Setări Disponibile:**

| Setare | Implicit | Descriere |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | Model AI pentru observații |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | Port serviciu worker |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | Locația directorului de date |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | Verbozitate loguri (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | Versiune Python pentru chroma-mcp |
| `CLAUDE_CODE_PATH` | _(auto-detect)_ | Cale către executabilul Claude |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Număr de observații de injectat la SessionStart |

**Gestionarea Setărilor:**

```bash
# Editați setările via helper CLI
./claude-mem-settings.sh

# Sau editați direct
nano ~/.claude-mem/settings.json

# Vizualizați setările curente
curl http://localhost:37777/api/settings
```

**Format Fișier Setări:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

Vedeți [Ghidul de Configurare](https://docs.claude-mem.ai/configuration) pentru detalii.

---

## Dezvoltare

```bash
# Clonați și construiți
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# Rulați teste
npm test

# Porniți worker
npm run worker:start

# Vizualizați loguri
npm run worker:logs
```

Vedeți [Ghidul de Dezvoltare](https://docs.claude-mem.ai/development) pentru instrucțiuni detaliate.

---

## Depanare

**Diagnostic Rapid:**

Dacă întâmpinați probleme, descrieți problema lui Claude și abilitatea troubleshoot se va activa automat pentru a diagnostica și furniza remedieri.

**Probleme Comune:**

- Worker nu pornește → `npm run worker:restart`
- Nu apare context → `npm run test:context`
- Probleme de bază de date → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Căutarea nu funcționează → Verificați dacă tabelele FTS5 există

Vedeți [Ghidul de Depanare](https://docs.claude-mem.ai/troubleshooting) pentru soluții complete.

---

## Contribuții

Contribuțiile sunt binevenite! Vă rugăm:

1. Faceți fork la repository
2. Creați o ramură de funcționalitate
3. Efectuați modificările cu teste
4. Actualizați documentația
5. Trimiteți un Pull Request

Vedeți [Ghidul de Dezvoltare](https://docs.claude-mem.ai/development) pentru fluxul de contribuție.

---

## Licență

Acest proiect este licențiat sub **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Toate drepturile rezervate.

Vedeți fișierul [LICENSE](LICENSE) pentru detalii complete.

**Ce Înseamnă Aceasta:**

- Puteți utiliza, modifica și distribui acest software liber
- Dacă modificați și implementați pe un server de rețea, trebuie să puneți codul sursă la dispoziție
- Lucrările derivate trebuie de asemenea licențiate sub AGPL-3.0
- Nu există NICIO GARANȚIE pentru acest software

---

## Suport

- **Documentație**: [docs/](docs/)
- **Probleme**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Autor**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Construit cu Claude Agent SDK** | **Alimentat de Claude Code** | **Făcut cu TypeScript**