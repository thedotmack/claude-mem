🌐 Dies ist eine von der Community gepflegte Übersetzung. Korrekturen sind willkommen!

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

**Languages:** [English](../../README.md) · [中文](./README.zh.md) · [Español](./README.es.md) · [Français](./README.fr.md) · [Português](./README.pt-br.md) · [Русский](./README.ru.md) · [Deutsch](./README.de.md)

<h4 align="center">Persistentes Speicherkompressionssystem für <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License">
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

<table align="center">
  <tr>
    <td align="center">
      <a href="https://github.com/thedotmack/claude-mem">
        <picture>
          <img
            src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/cm-preview.gif"
            alt="Claude-Mem Preview"
            width="500"
          >
        </picture>
      </a>
    </td>
    <td align="center">
      <a href="https://www.star-history.com/#thedotmack/claude-mem&Date">
        <picture>
          <source
            media="(prefers-color-scheme: dark)"
            srcset="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&theme=dark&legend=top-left"
          />
          <source
            media="(prefers-color-scheme: light)"
            srcset="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&legend=top-left"
          />
          <img
            alt="Star History Chart"
            src="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&legend=top-left"
            width="500"
          />
        </picture>
      </a>
    </td>
  </tr>
</table>

<p align="center">
  <a href="#quick-start">Schnellstart</a> •
  <a href="#how-it-works">Funktionsweise</a> •
  <a href="#mcp-search-tools">Suchtools</a> •
  <a href="#documentation">Dokumentation</a> •
  <a href="#configuration">Konfiguration</a> •
  <a href="#troubleshooting">Fehlerbehebung</a> •
  <a href="#license">Lizenz</a>
</p>

<p align="center">
  Claude-Mem bewahrt nahtlos Kontext über Sitzungen hinweg, indem es automatisch Beobachtungen der Tool-Nutzung erfasst, semantische Zusammenfassungen erzeugt und sie für zukünftige Sitzungen verfügbar macht. So kann Claude die Kontinuität des Projektwissens auch nach Sitzungsende oder Neuverbindung aufrechterhalten.
</p>

---

## Schnellstart

Installation mit einem einzigen Befehl:

```bash
npx claude-mem install
```

Oder Installation für Gemini CLI (erkennt automatisch `~/.gemini`):

```bash
npx claude-mem install --ide gemini-cli
```
Oder Installation für OpenCode:

```bash
npx claude-mem install --ide opencode
```

Oder Installation über den Plugin-Marketplace in Claude Code:

```bash
/plugin marketplace add thedotmack/claude-mem

/plugin install claude-mem
```

Starten Sie Claude Code oder Gemini CLI neu. Kontext aus früheren Sitzungen erscheint automatisch in neuen Sitzungen.

> **Hinweis:** Claude-Mem ist auch auf npm veröffentlicht, aber `npm install -g claude-mem` installiert **nur das SDK/die Bibliothek** — es registriert nicht die Plugin-Hooks und richtet den Worker-Service nicht ein. Installieren Sie immer über `npx claude-mem install` oder die obigen `/plugin`-Befehle.

### 🦞 OpenClaw Gateway

Installieren Sie claude-mem als persistentes Speicher-Plugin auf [OpenClaw](https://openclaw.ai)-Gateways mit einem einzigen Befehl:

```bash
curl -fsSL https://install.cmem.ai/openclaw.sh | bash
```

Der Installer übernimmt Abhängigkeiten, Plugin-Setup, AI-Provider-Konfiguration, Worker-Start und optionale Echtzeit-Beobachtungsfeeds zu Telegram, Discord, Slack und mehr. Details siehe [OpenClaw-Integrationsleitfaden](https://docs.claude-mem.ai/openclaw-integration).

**Hauptfunktionen:**

- 🧠 **Persistenter Speicher** - Kontext bleibt über Sitzungen erhalten
- 📊 **Progressive Disclosure** - Schichtweise Speicherabfrage mit sichtbaren Token-Kosten
- 🔍 **Skill-basierte Suche** - Projektverlauf mit der mem-search-Skill abfragen
- 🖥️ **Web-Viewer-UI** - Echtzeit-Speicherstream unter http://localhost:37777
- 💻 **Claude Desktop Skill** - Speicher aus Claude-Desktop-Gesprächen durchsuchen
- 🔒 **Datenschutzkontrolle** - `<private>`-Tags verwenden, um sensible Inhalte vom Speichern auszuschließen
- ⚙️ **Kontextkonfiguration** - Feingranulare Steuerung der injizierten Kontexte
- 🤖 **Automatischer Betrieb** - Kein manuelles Eingreifen erforderlich
- 🔗 **Zitate** - Frühere Beobachtungen per ID referenzieren (Zugriff über http://localhost:37777/api/observation/{id} oder alle im Web-Viewer unter http://localhost:37777 ansehen)
- 🧪 **Beta-Kanal** - Experimentelle Funktionen wie Endless Mode per Versionswechsel ausprobieren

---

## Dokumentation

📚 **[Vollständige Dokumentation ansehen](https://docs.claude-mem.ai/)** - Auf der offiziellen Website durchsuchen

### Erste Schritte

- **[Installationsleitfaden](https://docs.claude-mem.ai/installation)** - Schnellstart und erweiterte Installation
- **[Gemini CLI Setup](https://docs.claude-mem.ai/gemini-cli/setup)** - Dedizierter Leitfaden für die Google Gemini CLI-Integration
- **[Nutzungsleitfaden](https://docs.claude-mem.ai/usage/getting-started)** - Wie Claude-Mem automatisch funktioniert
- **[Suchtools](https://docs.claude-mem.ai/usage/search-tools)** - Projektverlauf in natürlicher Sprache abfragen
- **[Beta-Funktionen](https://docs.claude-mem.ai/beta-features)** - Experimentelle Funktionen wie Endless Mode ausprobieren

### Best Practices

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - Prinzipien zur Optimierung des AI-Agent-Kontexts
- **[Progressive Disclosure](https://docs.claude-mem.ai/progressive-disclosure)** - Philosophie hinter Claude-Mems Kontext-Priming-Strategie

### Architektur

- **[Überblick](https://docs.claude-mem.ai/architecture/overview)** - Systemkomponenten und Datenfluss
- **[Architekturentwicklung](https://docs.claude-mem.ai/architecture-evolution)** - Der Weg von v3 zu v5
- **[Hooks-Architektur](https://docs.claude-mem.ai/hooks-architecture)** - Wie Claude-Mem Lifecycle-Hooks nutzt
- **[Hooks-Referenz](https://docs.claude-mem.ai/architecture/hooks)** - 7 Hook-Skripte erklärt
- **[Worker-Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP-API und Bun-Verwaltung
- **[Datenbank](https://docs.claude-mem.ai/architecture/database)** - SQLite-Schema und FTS5-Suche
- **[Sucharchitektur](https://docs.claude-mem.ai/architecture/search-architecture)** - Hybride Suche mit Chroma-Vektordatenbank

### Konfiguration & Entwicklung

- **[Konfiguration](https://docs.claude-mem.ai/configuration)** - Umgebungsvariablen und Einstellungen
- **[Entwicklung](https://docs.claude-mem.ai/development)** - Build, Tests, Beitragen
- **[Fehlerbehebung](https://docs.claude-mem.ai/troubleshooting)** - Häufige Probleme und Lösungen

---

## Funktionsweise

**Kernkomponenten:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 Hook-Skripte)
2. **Smart Install** - Gecachter Abhängigkeitsprüfer (Pre-Hook-Skript, kein Lifecycle Hook)
3. **Worker-Service** - HTTP-API auf Port 37777 mit Web-Viewer-UI und 10 Such-Endpunkten, verwaltet von Bun
4. **SQLite-Datenbank** - Speichert Sitzungen, Beobachtungen, Zusammenfassungen
5. **mem-search Skill** - Natürlichsprachliche Abfragen mit progressive disclosure
6. **Chroma-Vektordatenbank** - Hybride semantische + Keyword-Suche für intelligente Kontextabfrage

Details siehe [Architekturüberblick](https://docs.claude-mem.ai/architecture/overview).

---

## MCP-Suchtools

Claude-Mem bietet intelligente Speichersuche über **4 MCP-Tools** mit einem token-effizienten **3-Schicht-Workflow-Muster**:

**Der 3-Schicht-Workflow:**

1. **`search`** - Kompakten Index mit IDs abrufen (~50-100 Tokens/Ergebnis)
2. **`timeline`** - Chronologischen Kontext um interessante Ergebnisse abrufen
3. **`get_observations`** - Vollständige Details NUR für gefilterte IDs abrufen (~500-1.000 Tokens/Ergebnis)

**Funktionsweise:**
- Claude nutzt MCP-Tools, um Ihren Speicher zu durchsuchen
- Beginnen Sie mit `search`, um einen Ergebnisindex zu erhalten
- Nutzen Sie `timeline`, um zu sehen, was um bestimmte Beobachtungen herum passierte
- Nutzen Sie `get_observations`, um vollständige Details für relevante IDs abzurufen
- **~10x Token-Einsparung** durch Filtern vor dem Abruf der Details

**Verfügbare MCP-Tools:**

1. **`search`** - Speicherindex mit Volltextabfragen durchsuchen, Filter nach Typ/Datum/Projekt
2. **`timeline`** - Chronologischen Kontext um eine bestimmte Beobachtung oder Abfrage abrufen
3. **`get_observations`** - Vollständige Beobachtungsdetails per IDs abrufen (immer mehrere IDs bündeln)

**Beispielnutzung:**

```typescript
// Step 1: Search for index
search(query="authentication bug", type="bugfix", limit=10)

// Step 2: Review index, identify relevant IDs (e.g., #123, #456)

// Step 3: Fetch full details
get_observations(ids=[123, 456])
```

Detaillierte Beispiele siehe [Suchtools-Leitfaden](https://docs.claude-mem.ai/usage/search-tools).

---

## Beta-Funktionen

Claude-Mem bietet einen **Beta-Kanal** mit experimentellen Funktionen wie **Endless Mode** (biomimetische Speicherarchitektur für längere Sitzungen). Wechseln Sie zwischen stabiler und Beta-Version in der Web-Viewer-UI unter http://localhost:37777 → Settings.

Details zu Endless Mode und zur Nutzung siehe **[Beta-Funktionen-Dokumentation](https://docs.claude-mem.ai/beta-features)**.

---

## Systemanforderungen

- **Node.js**: 18.0.0 oder höher
- **Claude Code**: Neueste Version mit Plugin-Unterstützung
- **Bun**: JavaScript-Runtime und Prozessmanager (wird bei Bedarf automatisch installiert)
- **uv**: Python-Paketmanager für Vektorsuche (wird bei Bedarf automatisch installiert)
- **SQLite 3**: Für persistente Speicherung (enthalten)

---
### Windows-Setup-Hinweise

Wenn Sie einen Fehler wie diesen sehen:

```powershell
npm : The term 'npm' is not recognized as the name of a cmdlet
```

Stellen Sie sicher, dass Node.js und npm installiert und zu Ihrem PATH hinzugefügt sind. Laden Sie den neuesten Node.js-Installer von https://nodejs.org herunter und starten Sie Ihr Terminal nach der Installation neu.

---

## Konfiguration

Einstellungen werden in `~/.claude-mem/settings.json` verwaltet (wird beim ersten Start automatisch mit Standardwerten erstellt). Konfigurieren Sie AI-Modell, Worker-Port, Datenverzeichnis, Log-Level und Kontext-Injektionseinstellungen.

Alle verfügbaren Einstellungen und Beispiele siehe **[Konfigurationsleitfaden](https://docs.claude-mem.ai/configuration)**.

### Modus- und Sprachkonfiguration

Claude-Mem unterstützt mehrere Workflow-Modi und Sprachen über die Einstellung `CLAUDE_MEM_MODE`.

Diese Option steuert beides:
- Das Workflow-Verhalten (z. B. code, chill, investigation)
- Die Sprache in generierten Beobachtungen

#### Konfiguration

Bearbeiten Sie Ihre Einstellungsdatei unter `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_MODE": "code--zh"
}
```

Modi sind in `plugin/modes/` definiert. Alle verfügbaren Modi lokal anzeigen:

```bash
ls ~/.claude/plugins/marketplaces/thedotmack/plugin/modes/
```

#### Verfügbare Modi

| Mode | Description |
|------------|-------------------------|
| `code` | Standard-Englischmodus |
| `code--zh` | Modus für vereinfachtes Chinesisch |
| `code--ja` | Japanischer Modus |

Sprachspezifische Modi folgen dem Muster `code--[lang]`, wobei `[lang]` der ISO-639-1-Sprachcode ist (z. B. `zh` für Chinesisch, `ja` für Japanisch, `es` für Spanisch).

> Hinweis: `code--zh` (vereinfachtes Chinesisch) ist bereits integriert — keine zusätzliche Installation oder Plugin-Aktualisierung erforderlich.

#### Nach Moduswechsel

Starten Sie Claude Code neu, um die neue Moduskonfiguration anzuwenden.
---

## Entwicklung

Build-Anweisungen, Tests und Beitragsworkflow siehe **[Entwicklungsleitfaden](https://docs.claude-mem.ai/development)**.

---

## Fehlerbehebung

Bei Problemen beschreiben Sie diese Claude — die troubleshoot-Skill diagnostiziert automatisch und liefert Lösungen.

Häufige Probleme und Lösungen siehe **[Fehlerbehebungsleitfaden](https://docs.claude-mem.ai/troubleshooting)**.

---

## Fehlerberichte

Erstellen Sie umfassende Fehlerberichte mit dem automatischen Generator:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Mitwirken

Beiträge sind willkommen! Bitte:

1. Forken Sie das Repository
2. Erstellen Sie einen Feature-Branch
3. Nehmen Sie Ihre Änderungen mit Tests vor
4. Aktualisieren Sie die Dokumentation
5. Reichen Sie einen Pull Request ein

Beitragsworkflow siehe [Entwicklungsleitfaden](https://docs.claude-mem.ai/development).

---

## Lizenz

Claude-Mem ist unter der Apache License 2.0 lizenziert.

Wir haben Apache-2.0 gewählt, weil dauerhafter Agentenspeicher leicht einbettbar sein sollte in
Entwickler-Tools, lokale Agenten, MCP-Server, Unternehmenssysteme, Robotik-Stacks
und Production-Agent-Harnesses.

Vollständige Details siehe [LICENSE](LICENSE). Siehe auch [docs/license.md](docs/license.md)
und [docs/ip-boundary.md](docs/ip-boundary.md) für Lizenzumfang und die
Open/Commercial-Grenze.

**Hinweis zu Ragtime**: Das Verzeichnis `ragtime/` ist unter der **Apache License 2.0** lizenziert. Details siehe [ragtime/LICENSE](ragtime/LICENSE).

---

## Support

- **Dokumentation**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Offizieller X-Account**: [@Claude_Memory](https://x.com/Claude_Memory)
- **Offizieller Discord**: [Discord beitreten](https://discord.com/invite/J4wttp9vDu)
- **Autor**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Erstellt mit Claude Agent SDK** | **Funktioniert mit Claude Code** | **Erstellt mit TypeScript**

---

### Was ist mit $CMEM?

$CMEM ist ein Solana-Token, der von Dritten ohne vorherige Zustimmung von Claude-Mem erstellt wurde, aber offiziell vom Ersteller von Claude-Mem (Alex Newman, @thedotmack) angenommen wurde. Der Token dient als Community-Katalysator für Wachstum und als Vehikel, um Echtzeit-Agentendaten zu den Entwicklern und Wissensarbeitern zu bringen, die sie am meisten brauchen. $CMEM: 2TsmuYUrsctE57VLckZBYEEzdokUF8j8e1GavekWBAGS
