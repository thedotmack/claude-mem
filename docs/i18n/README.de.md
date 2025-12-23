🌐 Dies ist eine automatisierte Übersetzung. Korrekturen aus der Community sind willkommen!

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

<h4 align="center">Persistentes Speicherkomprimierungssystem entwickelt für <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#schnellstart">Schnellstart</a> •
  <a href="#wie-es-funktioniert">Wie es funktioniert</a> •
  <a href="#mcp-suchwerkzeuge">Suchwerkzeuge</a> •
  <a href="#dokumentation">Dokumentation</a> •
  <a href="#konfiguration">Konfiguration</a> •
  <a href="#fehlerbehebung">Fehlerbehebung</a> •
  <a href="#lizenz">Lizenz</a>
</p>

<p align="center">
  Claude-Mem bewahrt nahtlos Kontext über Sitzungen hinweg, indem es automatisch Beobachtungen zur Tool-Nutzung erfasst, semantische Zusammenfassungen generiert und diese für zukünftige Sitzungen verfügbar macht. Dies ermöglicht es Claude, die Kontinuität des Wissens über Projekte aufrechtzuerhalten, auch nachdem Sitzungen beendet wurden oder die Verbindung wiederhergestellt wird.
</p>

---

## Schnellstart

Starten Sie eine neue Claude Code-Sitzung im Terminal und geben Sie die folgenden Befehle ein:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Starten Sie Claude Code neu. Kontext aus vorherigen Sitzungen wird automatisch in neuen Sitzungen angezeigt.

**Hauptmerkmale:**

- 🧠 **Persistenter Speicher** - Kontext bleibt über Sitzungen hinweg erhalten
- 📊 **Progressive Offenlegung** - Schichtweise Speicherabruf mit Sichtbarkeit der Token-Kosten
- 🔍 **Skill-basierte Suche** - Durchsuchen Sie Ihre Projekthistorie mit dem mem-search Skill
- 🖥️ **Web-Viewer-UI** - Echtzeit-Speicherstream unter http://localhost:37777
- 💻 **Claude Desktop Skill** - Durchsuchen Sie den Speicher aus Claude Desktop-Konversationen
- 🔒 **Datenschutzkontrolle** - Verwenden Sie `<private>`-Tags, um sensible Inhalte von der Speicherung auszuschließen
- ⚙️ **Kontextkonfiguration** - Feinkörnige Kontrolle darüber, welcher Kontext eingefügt wird
- 🤖 **Automatischer Betrieb** - Keine manuelle Intervention erforderlich
- 🔗 **Zitate** - Referenzieren Sie vergangene Beobachtungen mit IDs (Zugriff über http://localhost:37777/api/observation/{id} oder alle im Web-Viewer unter http://localhost:37777 anzeigen)
- 🧪 **Beta-Kanal** - Probieren Sie experimentelle Funktionen wie den Endless Mode durch Versionswechsel aus

---

## Dokumentation

📚 **[Vollständige Dokumentation anzeigen](docs/)** - Markdown-Dokumentation auf GitHub durchsuchen

### Erste Schritte

- **[Installationsanleitung](https://docs.claude-mem.ai/installation)** - Schnellstart & erweiterte Installation
- **[Nutzungsanleitung](https://docs.claude-mem.ai/usage/getting-started)** - Wie Claude-Mem automatisch funktioniert
- **[Suchwerkzeuge](https://docs.claude-mem.ai/usage/search-tools)** - Durchsuchen Sie Ihre Projekthistorie mit natürlicher Sprache
- **[Beta-Funktionen](https://docs.claude-mem.ai/beta-features)** - Probieren Sie experimentelle Funktionen wie den Endless Mode

### Best Practices

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - Prinzipien der Kontextoptimierung für KI-Agenten
- **[Progressive Disclosure](https://docs.claude-mem.ai/progressive-disclosure)** - Philosophie hinter Claude-Mems Kontext-Priming-Strategie

### Architektur

- **[Übersicht](https://docs.claude-mem.ai/architecture/overview)** - Systemkomponenten & Datenfluss
- **[Architekturentwicklung](https://docs.claude-mem.ai/architecture-evolution)** - Die Reise von v3 zu v5
- **[Hooks-Architektur](https://docs.claude-mem.ai/hooks-architecture)** - Wie Claude-Mem Lifecycle-Hooks verwendet
- **[Hooks-Referenz](https://docs.claude-mem.ai/architecture/hooks)** - 7 Hook-Skripte erklärt
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API & Bun-Verwaltung
- **[Datenbank](https://docs.claude-mem.ai/architecture/database)** - SQLite-Schema & FTS5-Suche
- **[Such-Architektur](https://docs.claude-mem.ai/architecture/search-architecture)** - Hybride Suche mit Chroma-Vektordatenbank

### Konfiguration & Entwicklung

- **[Konfiguration](https://docs.claude-mem.ai/configuration)** - Umgebungsvariablen & Einstellungen
- **[Entwicklung](https://docs.claude-mem.ai/development)** - Erstellen, Testen, Beitragen
- **[Fehlerbehebung](https://docs.claude-mem.ai/troubleshooting)** - Häufige Probleme & Lösungen

---

## Wie es funktioniert

**Kernkomponenten:**

1. **5 Lifecycle-Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 Hook-Skripte)
2. **Smart Install** - Gecachter Abhängigkeitsprüfer (Pre-Hook-Skript, kein Lifecycle-Hook)
3. **Worker Service** - HTTP API auf Port 37777 mit Web-Viewer-UI und 10 Such-Endpunkten, verwaltet von Bun
4. **SQLite-Datenbank** - Speichert Sitzungen, Beobachtungen, Zusammenfassungen
5. **mem-search Skill** - Natürlichsprachliche Abfragen mit progressiver Offenlegung
6. **Chroma-Vektordatenbank** - Hybride semantische + Stichwortsuche für intelligenten Kontextabruf

Siehe [Architekturübersicht](https://docs.claude-mem.ai/architecture/overview) für Details.

---

## mem-search Skill

Claude-Mem bietet intelligente Suche durch den mem-search Skill, der sich automatisch aktiviert, wenn Sie nach früheren Arbeiten fragen:

**Wie es funktioniert:**
- Fragen Sie einfach natürlich: *"Was haben wir in der letzten Sitzung gemacht?"* oder *"Haben wir diesen Fehler schon einmal behoben?"*
- Claude aktiviert automatisch den mem-search Skill, um relevanten Kontext zu finden

**Verfügbare Suchoperationen:**

1. **Search Observations** - Volltextsuche über Beobachtungen
2. **Search Sessions** - Volltextsuche über Sitzungszusammenfassungen
3. **Search Prompts** - Durchsuchen von rohen Benutzeranfragen
4. **By Concept** - Suche nach Konzept-Tags (discovery, problem-solution, pattern, etc.)
5. **By File** - Beobachtungen finden, die bestimmte Dateien referenzieren
6. **By Type** - Suche nach Typ (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Aktuellen Sitzungskontext für ein Projekt abrufen
8. **Timeline** - Einheitliche Zeitachse des Kontexts um einen bestimmten Zeitpunkt herum abrufen
9. **Timeline by Query** - Nach Beobachtungen suchen und Zeitachsenkontext um die beste Übereinstimmung herum abrufen
10. **API Help** - Such-API-Dokumentation abrufen

**Beispiele für natürlichsprachliche Abfragen:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

Siehe [Suchwerkzeuge-Anleitung](https://docs.claude-mem.ai/usage/search-tools) für detaillierte Beispiele.

---

## Beta-Funktionen

Claude-Mem bietet einen **Beta-Kanal** mit experimentellen Funktionen wie **Endless Mode** (biomimetische Speicherarchitektur für erweiterte Sitzungen). Wechseln Sie zwischen stabilen und Beta-Versionen über die Web-Viewer-UI unter http://localhost:37777 → Settings.

Siehe **[Beta-Funktionen-Dokumentation](https://docs.claude-mem.ai/beta-features)** für Details zum Endless Mode und wie Sie ihn ausprobieren können.

---

## Systemanforderungen

- **Node.js**: 18.0.0 oder höher
- **Claude Code**: Neueste Version mit Plugin-Unterstützung
- **Bun**: JavaScript-Laufzeitumgebung und Prozessmanager (wird automatisch installiert, falls fehlend)
- **uv**: Python-Paketmanager für Vektorsuche (wird automatisch installiert, falls fehlend)
- **SQLite 3**: Für persistente Speicherung (enthalten)

---

## Konfiguration

Einstellungen werden in `~/.claude-mem/settings.json` verwaltet (wird beim ersten Start automatisch mit Standardwerten erstellt). Konfigurieren Sie KI-Modell, Worker-Port, Datenverzeichnis, Log-Level und Kontext-Injektionseinstellungen.

Siehe die **[Konfigurationsanleitung](https://docs.claude-mem.ai/configuration)** für alle verfügbaren Einstellungen und Beispiele.

---

## Entwicklung

Siehe die **[Entwicklungsanleitung](https://docs.claude-mem.ai/development)** für Build-Anweisungen, Tests und Beitrags-Workflow.

---

## Fehlerbehebung

Wenn Sie Probleme haben, beschreiben Sie das Problem Claude und der troubleshoot Skill wird automatisch diagnostizieren und Lösungen bereitstellen.

Siehe die **[Fehlerbehebungsanleitung](https://docs.claude-mem.ai/troubleshooting)** für häufige Probleme und Lösungen.

---

## Fehlerberichte

Erstellen Sie umfassende Fehlerberichte mit dem automatisierten Generator:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Beiträge

Beiträge sind willkommen! Bitte:

1. Forken Sie das Repository
2. Erstellen Sie einen Feature-Branch
3. Nehmen Sie Ihre Änderungen mit Tests vor
4. Aktualisieren Sie die Dokumentation
5. Reichen Sie einen Pull Request ein

Siehe [Entwicklungsanleitung](https://docs.claude-mem.ai/development) für den Beitrags-Workflow.

---

## Lizenz

Dieses Projekt ist unter der **GNU Affero General Public License v3.0** (AGPL-3.0) lizenziert.

Copyright (C) 2025 Alex Newman (@thedotmack). Alle Rechte vorbehalten.

Siehe die [LICENSE](LICENSE)-Datei für vollständige Details.

**Was das bedeutet:**

- Sie können diese Software frei verwenden, modifizieren und verteilen
- Wenn Sie sie modifizieren und auf einem Netzwerkserver bereitstellen, müssen Sie Ihren Quellcode verfügbar machen
- Abgeleitete Werke müssen ebenfalls unter AGPL-3.0 lizenziert werden
- Es gibt KEINE GARANTIE für diese Software

**Hinweis zu Ragtime**: Das `ragtime/`-Verzeichnis ist separat unter der **PolyForm Noncommercial License 1.0.0** lizenziert. Siehe [ragtime/LICENSE](ragtime/LICENSE) für Details.

---

## Support

- **Dokumentation**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Autor**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Erstellt mit Claude Agent SDK** | **Powered by Claude Code** | **Made with TypeScript**