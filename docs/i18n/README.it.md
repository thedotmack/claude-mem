🌐 Questa è una traduzione automatica. Le correzioni della comunità sono benvenute!

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

<h4 align="center">Sistema di compressione della memoria persistente creato per <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#avvio-rapido">Avvio Rapido</a> •
  <a href="#come-funziona">Come Funziona</a> •
  <a href="#strumenti-di-ricerca">Strumenti di Ricerca</a> •
  <a href="#documentazione">Documentazione</a> •
  <a href="#configurazione">Configurazione</a> •
  <a href="#risoluzione-dei-problemi">Risoluzione dei Problemi</a> •
  <a href="#licenza">Licenza</a>
</p>

<p align="center">
  Claude-Mem preserva il contesto in modo fluido tra le sessioni catturando automaticamente le osservazioni sull'utilizzo degli strumenti, generando riepiloghi semantici e rendendoli disponibili per le sessioni future. Questo consente a Claude di mantenere la continuità della conoscenza sui progetti anche dopo la fine o la riconnessione delle sessioni.
</p>

---

## Avvio Rapido

Avvia una nuova sessione di Claude Code nel terminale e inserisci i seguenti comandi:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Riavvia Claude Code. Il contesto delle sessioni precedenti apparirà automaticamente nelle nuove sessioni.

**Caratteristiche Principali:**

- 🧠 **Memoria Persistente** - Il contesto sopravvive tra le sessioni
- 📊 **Divulgazione Progressiva** - Recupero della memoria a strati con visibilità del costo in token
- 🔍 **Ricerca Basata su Skill** - Interroga la cronologia del tuo progetto con la skill mem-search
- 🖥️ **Interfaccia Web Viewer** - Stream della memoria in tempo reale su http://localhost:37777
- 💻 **Skill per Claude Desktop** - Cerca nella memoria dalle conversazioni di Claude Desktop
- 🔒 **Controllo della Privacy** - Usa i tag `<private>` per escludere contenuti sensibili dall'archiviazione
- ⚙️ **Configurazione del Contesto** - Controllo granulare su quale contesto viene iniettato
- 🤖 **Funzionamento Automatico** - Nessun intervento manuale richiesto
- 🔗 **Citazioni** - Fai riferimento a osservazioni passate con ID (accedi tramite http://localhost:37777/api/observation/{id} o visualizza tutto nel web viewer su http://localhost:37777)
- 🧪 **Canale Beta** - Prova funzionalità sperimentali come Endless Mode tramite il cambio di versione

---

## Documentazione

📚 **[Visualizza Documentazione Completa](https://docs.claude-mem.ai/)** - Sfoglia sul sito ufficiale

### Per Iniziare

- **[Guida all'Installazione](https://docs.claude-mem.ai/installation)** - Avvio rapido e installazione avanzata
- **[Guida all'Uso](https://docs.claude-mem.ai/usage/getting-started)** - Come funziona automaticamente Claude-Mem
- **[Strumenti di Ricerca](https://docs.claude-mem.ai/usage/search-tools)** - Interroga la cronologia del progetto con linguaggio naturale
- **[Funzionalità Beta](https://docs.claude-mem.ai/beta-features)** - Prova funzionalità sperimentali come Endless Mode

### Best Practice

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - Principi di ottimizzazione del contesto per agenti AI
- **[Progressive Disclosure](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofia alla base della strategia di priming del contesto di Claude-Mem

### Architettura

- **[Panoramica](https://docs.claude-mem.ai/architecture/overview)** - Componenti del sistema e flusso dei dati
- **[Evoluzione dell'Architettura](https://docs.claude-mem.ai/architecture-evolution)** - Il percorso dalla v3 alla v5
- **[Architettura degli Hook](https://docs.claude-mem.ai/hooks-architecture)** - Come Claude-Mem utilizza gli hook del ciclo di vita
- **[Riferimento Hook](https://docs.claude-mem.ai/architecture/hooks)** - Spiegazione dei 7 script hook
- **[Servizio Worker](https://docs.claude-mem.ai/architecture/worker-service)** - API HTTP e gestione Bun
- **[Database](https://docs.claude-mem.ai/architecture/database)** - Schema SQLite e ricerca FTS5
- **[Architettura di Ricerca](https://docs.claude-mem.ai/architecture/search-architecture)** - Ricerca ibrida con database vettoriale Chroma

### Configurazione e Sviluppo

- **[Configurazione](https://docs.claude-mem.ai/configuration)** - Variabili d'ambiente e impostazioni
- **[Sviluppo](https://docs.claude-mem.ai/development)** - Build, test e flusso di contribuzione
- **[Risoluzione dei Problemi](https://docs.claude-mem.ai/troubleshooting)** - Problemi comuni e soluzioni

---

## Come Funziona

**Componenti Principali:**

1. **5 Hook del Ciclo di Vita** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 script hook)
2. **Installazione Intelligente** - Controllo delle dipendenze in cache (script pre-hook, non un hook del ciclo di vita)
3. **Servizio Worker** - API HTTP sulla porta 37777 con interfaccia web viewer e 10 endpoint di ricerca, gestita da Bun
4. **Database SQLite** - Memorizza sessioni, osservazioni, riepiloghi
5. **Skill mem-search** - Query in linguaggio naturale con divulgazione progressiva
6. **Database Vettoriale Chroma** - Ricerca ibrida semantica + keyword per recupero intelligente del contesto

Vedi [Panoramica dell'Architettura](https://docs.claude-mem.ai/architecture/overview) per i dettagli.

---

## Skill mem-search

Claude-Mem fornisce una ricerca intelligente tramite la skill mem-search che si attiva automaticamente quando chiedi del lavoro passato:

**Come Funziona:**
- Chiedi semplicemente in modo naturale: *"Cosa abbiamo fatto nell'ultima sessione?"* o *"Abbiamo già risolto questo bug prima?"*
- Claude invoca automaticamente la skill mem-search per trovare il contesto rilevante

**Operazioni di Ricerca Disponibili:**

1. **Search Observations** - Ricerca full-text nelle osservazioni
2. **Search Sessions** - Ricerca full-text nei riepiloghi delle sessioni
3. **Search Prompts** - Ricerca nelle richieste utente grezze
4. **By Concept** - Trova per tag di concetto (discovery, problem-solution, pattern, ecc.)
5. **By File** - Trova osservazioni che fanno riferimento a file specifici
6. **By Type** - Trova per tipo (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Ottieni il contesto recente della sessione per un progetto
8. **Timeline** - Ottieni la timeline unificata del contesto attorno a un punto specifico nel tempo
9. **Timeline by Query** - Cerca osservazioni e ottieni il contesto della timeline attorno alla corrispondenza migliore
10. **API Help** - Ottieni la documentazione dell'API di ricerca

**Esempi di Query in Linguaggio Naturale:**

```
"Quali bug abbiamo risolto nell'ultima sessione?"
"Come abbiamo implementato l'autenticazione?"
"Quali modifiche sono state apportate a worker-service.ts?"
"Mostrami il lavoro recente su questo progetto"
"Cosa stava succedendo quando abbiamo aggiunto l'interfaccia del viewer?"
```

Vedi [Guida agli Strumenti di Ricerca](https://docs.claude-mem.ai/usage/search-tools) per esempi dettagliati.

---

## Funzionalità Beta

Claude-Mem offre un **canale beta** con funzionalità sperimentali come **Endless Mode** (architettura di memoria biomimetica per sessioni estese). Passa dalla versione stabile a quella beta dall'interfaccia web viewer su http://localhost:37777 → Settings.

Vedi **[Documentazione delle Funzionalità Beta](https://docs.claude-mem.ai/beta-features)** per dettagli su Endless Mode e come provarlo.

---

## Requisiti di Sistema

- **Node.js**: 18.0.0 o superiore
- **Claude Code**: Ultima versione con supporto plugin
- **Bun**: Runtime JavaScript e process manager (installato automaticamente se mancante)
- **uv**: Gestore di pacchetti Python per la ricerca vettoriale (installato automaticamente se mancante)
- **SQLite 3**: Per l'archiviazione persistente (incluso)

---

## Configurazione

Le impostazioni sono gestite in `~/.claude-mem/settings.json` (creato automaticamente con valori predefiniti alla prima esecuzione). Configura il modello AI, la porta del worker, la directory dei dati, il livello di log e le impostazioni di iniezione del contesto.

Vedi la **[Guida alla Configurazione](https://docs.claude-mem.ai/configuration)** per tutte le impostazioni disponibili ed esempi.

---

## Sviluppo

Vedi la **[Guida allo Sviluppo](https://docs.claude-mem.ai/development)** per le istruzioni di build, test e flusso di contribuzione.

---

## Risoluzione dei Problemi

Se riscontri problemi, descrivi il problema a Claude e la skill troubleshoot diagnosticherà automaticamente e fornirà correzioni.

Vedi la **[Guida alla Risoluzione dei Problemi](https://docs.claude-mem.ai/troubleshooting)** per problemi comuni e soluzioni.

---

## Segnalazione Bug

Crea report di bug completi con il generatore automatizzato:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Contribuire

I contributi sono benvenuti! Per favore:

1. Fai il fork del repository
2. Crea un branch per la funzionalità
3. Apporta le tue modifiche con i test
4. Aggiorna la documentazione
5. Invia una Pull Request

Vedi [Guida allo Sviluppo](https://docs.claude-mem.ai/development) per il flusso di contribuzione.

---

## Licenza

Questo progetto è rilasciato sotto la **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Tutti i diritti riservati.

Vedi il file [LICENSE](LICENSE) per i dettagli completi.

**Cosa Significa:**

- Puoi usare, modificare e distribuire questo software liberamente
- Se modifichi e distribuisci su un server di rete, devi rendere disponibile il tuo codice sorgente
- Le opere derivate devono anche essere rilasciate sotto AGPL-3.0
- NON c'è GARANZIA per questo software

**Nota su Ragtime**: La directory `ragtime/` è rilasciata separatamente sotto la **PolyForm Noncommercial License 1.0.0**. Vedi [ragtime/LICENSE](ragtime/LICENSE) per i dettagli.

---

## Supporto

- **Documentazione**: [docs/](docs/)
- **Problemi**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Autore**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Creato con Claude Agent SDK** | **Alimentato da Claude Code** | **Realizzato con TypeScript**

---