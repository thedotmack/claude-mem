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
  <a href="#suchwerkzeuge">Suchwerkzeuge</a> •
  <a href="#dokumentation">Dokumentation</a> •
  <a href="#konfiguration">Konfiguration</a> •
  <a href="#fehlerbehebung">Fehlerbehebung</a> •
  <a href="#lizenz">Lizenz</a>
</p>

<p align="center">
  Claude-Mem bewahrt nahtlos den Kontext über Sitzungen hinweg, indem es automatisch Beobachtungen der Werkzeugnutzung erfasst, semantische Zusammenfassungen generiert und diese für zukünftige Sitzungen verfügbar macht. Dies ermöglicht es Claude, die Kontinuität des Wissens über Projekte aufrechtzuerhalten, selbst nachdem Sitzungen beendet oder wiederhergestellt wurden.
</p>

---

## Schnellstart

Starten Sie eine neue Claude Code Sitzung im Terminal und geben Sie die folgenden Befehle ein:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Starten Sie Claude Code neu. Kontext aus vorherigen Sitzungen wird automatisch in neuen Sitzungen angezeigt.

**Hauptmerkmale:**

- 🧠 **Persistenter Speicher** - Kontext überlebt Sitzungen
- 📊 **Progressive Disclosure** - Mehrschichtiger Speicherabruf mit Sichtbarkeit der Token-Kosten
- 🔍 **Skill-basierte Suche** - Durchsuchen Sie Ihre Projekthistorie mit mem-search Skill (~2.250 Token Einsparung)
- 🖥️ **Web Viewer UI** - Echtzeit-Speicherstrom unter http://localhost:37777
- 🔒 **Datenschutzkontrolle** - Verwenden Sie `<private>` Tags, um sensible Inhalte von der Speicherung auszuschließen
- ⚙️ **Kontextkonfiguration** - Feinkörnige Kontrolle darüber, welcher Kontext eingefügt wird
- 🤖 **Automatischer Betrieb** - Keine manuelle Intervention erforderlich
- 🔗 **Zitate** - Verweisen Sie auf frühere Entscheidungen mit `claude-mem://` URIs
- 🧪 **Beta-Kanal** - Testen Sie experimentelle Funktionen wie Endless Mode durch Versionswechsel

---

## Dokumentation

📚 **[Vollständige Dokumentation anzeigen](docs/)** - Markdown-Dokumente auf GitHub durchsuchen

💻 **Lokale Vorschau**: Führen Sie Mintlify-Dokumente lokal aus:

```bash
cd docs
npx mintlify dev
```

### Erste Schritte

- **[Installationsanleitung](https://docs.claude-mem.ai/installation)** - Schnellstart & erweiterte Installation
- **[Benutzerhandbuch](https://docs.claude-mem.ai/usage/getting-started)** - Wie Claude-Mem automatisch funktioniert
- **[Suchwerkzeuge](https://docs.claude-mem.ai/usage/search-tools)** - Durchsuchen Sie Ihre Projekthistorie mit natürlicher Sprache
- **[Beta-Funktionen](https://docs.claude-mem.ai/beta-features)** - Testen Sie experimentelle Funktionen wie Endless Mode

### Best Practices

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - KI-Agenten Kontextoptimierungsprinzipien
- **[Progressive Disclosure](https://docs.claude-mem.ai/progressive-disclosure)** - Philosophie hinter Claude-Mems Kontext-Priming-Strategie

### Architektur

- **[Übersicht](https://docs.claude-mem.ai/architecture/overview)** - Systemkomponenten & Datenfluss
- **[Architekturentwicklung](https://docs.claude-mem.ai/architecture-evolution)** - Die Reise von v3 zu v5
- **[Hooks-Architektur](https://docs.claude-mem.ai/hooks-architecture)** - Wie Claude-Mem Lifecycle-Hooks verwendet
- **[Hooks-Referenz](https://docs.claude-mem.ai/architecture/hooks)** - 7 Hook-Skripte erklärt
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API & PM2 Verwaltung
- **[Datenbank](https://docs.claude-mem.ai/architecture/database)** - SQLite Schema & FTS5 Suche
- **[Such-Architektur](https://docs.claude-mem.ai/architecture/search-architecture)** - Hybrid-Suche mit Chroma Vektordatenbank

### Konfiguration & Entwicklung

- **[Konfiguration](https://docs.claude-mem.ai/configuration)** - Umgebungsvariablen & Einstellungen
- **[Entwicklung](https://docs.claude-mem.ai/development)** - Erstellen, Testen, Beitragen
- **[Fehlerbehebung](https://docs.claude-mem.ai/troubleshooting)** - Häufige Probleme & Lösungen

---

## Wie es funktioniert

```
┌─────────────────────────────────────────────────────────────┐
│ Sitzungsstart → Aktuelle Beobachtungen als Kontext einfügen│
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Benutzerprompts → Sitzung erstellen, Benutzerprompts speichern│
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Werkzeugausführungen → Beobachtungen erfassen (Read, Write, etc.)│
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Worker-Prozesse → Erkenntnisse via Claude Agent SDK extrahieren│
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Sitzungsende → Zusammenfassung generieren, bereit für nächste Sitzung│
└─────────────────────────────────────────────────────────────┘
```

**Kernkomponenten:**

1. **5 Lifecycle-Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 Hook-Skripte)
2. **Smart Install** - Gecachter Abhängigkeitsprüfer (Pre-Hook-Skript, kein Lifecycle-Hook)
3. **Worker Service** - HTTP API auf Port 37777 mit Web Viewer UI und 10 Suchendpunkten, verwaltet von PM2
4. **SQLite Datenbank** - Speichert Sitzungen, Beobachtungen, Zusammenfassungen mit FTS5 Volltextsuche
5. **mem-search Skill** - Natürlichsprachige Abfragen mit progressiver Enthüllung (~2.250 Token Einsparung vs. MCP)
6. **Chroma Vektordatenbank** - Hybrid-semantische + Stichwortsuche für intelligenten Kontextabruf

Siehe [Architekturübersicht](https://docs.claude-mem.ai/architecture/overview) für Details.

---

## mem-search Skill

Claude-Mem bietet intelligente Suche durch den mem-search Skill, der automatisch aufgerufen wird, wenn Sie nach früherer Arbeit fragen:

**Wie es funktioniert:**
- Fragen Sie einfach natürlich: *"Was haben wir in der letzten Sitzung gemacht?"* oder *"Haben wir diesen Bug schon mal behoben?"*
- Claude ruft automatisch den mem-search Skill auf, um relevanten Kontext zu finden
- ~2.250 Token Einsparung pro Sitzungsstart im Vergleich zum MCP-Ansatz

**Verfügbare Suchvorgänge:**

1. **Search Observations** - Volltextsuche über Beobachtungen
2. **Search Sessions** - Volltextsuche über Sitzungszusammenfassungen
3. **Search Prompts** - Durchsuchen roher Benutzeranfragen
4. **By Concept** - Suche nach Konzept-Tags (discovery, problem-solution, pattern, etc.)
5. **By File** - Beobachtungen finden, die auf bestimmte Dateien verweisen
6. **By Type** - Suche nach Typ (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Aktuellen Sitzungskontext für ein Projekt abrufen
8. **Timeline** - Einheitliche Zeitachse des Kontexts um einen bestimmten Zeitpunkt herum abrufen
9. **Timeline by Query** - Nach Beobachtungen suchen und Zeitachsenkontext um die beste Übereinstimmung herum abrufen
10. **API Help** - Such-API-Dokumentation abrufen

**Beispiele für natürlichsprachige Abfragen:**

```
"Welche Bugs haben wir in der letzten Sitzung behoben?"
"Wie haben wir die Authentifizierung implementiert?"
"Welche Änderungen wurden an worker-service.ts vorgenommen?"
"Zeige mir die aktuelle Arbeit an diesem Projekt"
"Was geschah, als wir die Viewer UI hinzugefügt haben?"
```

Siehe [Suchwerkzeuge-Anleitung](https://docs.claude-mem.ai/usage/search-tools) für detaillierte Beispiele.

---

## Beta-Funktionen & Endless Mode

Claude-Mem bietet einen **Beta-Kanal** mit experimentellen Funktionen. Wechseln Sie direkt über die Web Viewer UI zwischen stabilen und Beta-Versionen.

### Wie Sie Beta ausprobieren

1. Öffnen Sie http://localhost:37777
2. Klicken Sie auf Einstellungen (Zahnradsymbol)
3. Klicken Sie unter **Version Channel** auf "Try Beta (Endless Mode)"
4. Warten Sie auf den Neustart des Workers

Ihre Speicherdaten bleiben beim Versionswechsel erhalten.

### Endless Mode (Beta)

Die Hauptfunktion der Beta ist **Endless Mode** - eine biomimetische Speicherarchitektur, die die Sitzungslänge dramatisch erweitert:

**Das Problem**: Standard Claude Code Sitzungen erreichen Kontextgrenzen nach ~50 Werkzeugnutzungen. Jedes Werkzeug fügt 1-10k+ Token hinzu, und Claude synthetisiert alle vorherigen Ausgaben bei jeder Antwort neu (O(N²) Komplexität).

**Die Lösung**: Endless Mode komprimiert Werkzeugausgaben in ~500-Token-Beobachtungen und transformiert das Transkript in Echtzeit:

```
Working Memory (Kontext):     Komprimierte Beobachtungen (~500 Token je)
Archive Memory (Disk):        Vollständige Werkzeugausgaben für Abruf bewahrt
```

**Erwartete Ergebnisse**:
- ~95% Token-Reduktion im Kontextfenster
- ~20x mehr Werkzeugnutzungen vor Kontexterschöpfung
- Lineare O(N) Skalierung statt quadratischer O(N²)
- Vollständige Transkripte für perfekten Abruf bewahrt

**Einschränkungen**: Fügt Latenz hinzu (60-90s pro Werkzeug für Beobachtungsgenerierung), noch experimentell.

Siehe [Beta-Funktionen-Dokumentation](https://docs.claude-mem.ai/beta-features) für Details.

---

## Was ist neu

**v6.4.9 - Kontextkonfigurationseinstellungen:**
- 11 neue Einstellungen für feinkörnige Kontrolle über Kontexteinfügung
- Konfigurieren Sie Token-Economics-Anzeige, Beobachtungsfilterung nach Typ/Konzept
- Steuern Sie die Anzahl der Beobachtungen und welche Felder angezeigt werden sollen

**v6.4.0 - Dual-Tag Datenschutzsystem:**
- `<private>` Tags für benutzergesteuerte Privatsphäre - schließen Sie sensible Inhalte von der Speicherung aus
- Systemebenen-`<claude-mem-context>` Tags verhindern rekursive Beobachtungsspeicherung
- Edge-Verarbeitung stellt sicher, dass private Inhalte nie die Datenbank erreichen

**v6.3.0 - Versionskanal:**
- Wechseln Sie zwischen stabilen und Beta-Versionen über die Web Viewer UI
- Testen Sie experimentelle Funktionen wie Endless Mode ohne manuelle Git-Operationen

**Frühere Highlights:**
- **v6.0.0**: Große Verbesserungen bei Sitzungsverwaltung & Transkriptverarbeitung
- **v5.5.0**: mem-search Skill-Verbesserung mit 100% Effektivitätsrate
- **v5.4.0**: Skill-basierte Sucharchitektur (~2.250 Token pro Sitzung gespart)
- **v5.1.0**: Webbasierte Viewer UI mit Echtzeit-Updates
- **v5.0.0**: Hybrid-Suche mit Chroma Vektordatenbank

Siehe [CHANGELOG.md](CHANGELOG.md) für vollständige Versionshistorie.

---

## Systemanforderungen

- **Node.js**: 18.0.0 oder höher
- **Claude Code**: Neueste Version mit Plugin-Unterstützung
- **PM2**: Prozessmanager (gebündelt - keine globale Installation erforderlich)
- **SQLite 3**: Für persistente Speicherung (gebündelt)

---

## Hauptvorteile

### Progressive Disclosure Context

- **Mehrschichtiger Speicherabruf** spiegelt menschliche Gedächtnismuster wider
- **Ebene 1 (Index)**: Sehen Sie, welche Beobachtungen existieren mit Token-Kosten beim Sitzungsstart
- **Ebene 2 (Details)**: Vollständige Narrative bei Bedarf über MCP-Suche abrufen
- **Ebene 3 (Perfekter Abruf)**: Zugriff auf Quellcode und ursprüngliche Transkripte
- **Intelligente Entscheidungsfindung**: Token-Zählungen helfen Claude bei der Wahl zwischen Detailabruf oder Code-Lesen
- **Typ-Indikatoren**: Visuelle Hinweise (🔴 kritisch, 🟤 Entscheidung, 🔵 informativ) heben Beobachtungswichtigkeit hervor

### Automatischer Speicher

- Kontext wird automatisch eingefügt, wenn Claude startet
- Keine manuellen Befehle oder Konfiguration erforderlich
- Funktioniert transparent im Hintergrund

### Vollständige Historiensuche

- Durchsuchen Sie alle Sitzungen und Beobachtungen
- FTS5 Volltextsuche für schnelle Abfragen
- Zitate verweisen zurück auf bestimmte Beobachtungen

### Strukturierte Beobachtungen

- KI-gestützte Extraktion von Erkenntnissen
- Kategorisiert nach Typ (decision, bugfix, feature, etc.)
- Mit Konzepten und Dateiverweisen gekennzeichnet

### Multi-Prompt-Sitzungen

- Sitzungen erstrecken sich über mehrere Benutzerprompts
- Kontext über `/clear` Befehle hinweg bewahrt
- Verfolgen Sie gesamte Gesprächsfäden

---

## Konfiguration

Einstellungen werden in `~/.claude-mem/settings.json` verwaltet. Die Datei wird beim ersten Start automatisch mit Standardwerten erstellt.

**Verfügbare Einstellungen:**

| Einstellung | Standard | Beschreibung |
|-------------|----------|--------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | KI-Modell für Beobachtungen |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | Worker Service Port |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | Datenverzeichnisspeicherort |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | Log-Ausführlichkeit (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | Python-Version für chroma-mcp |
| `CLAUDE_CODE_PATH` | _(auto-detect)_ | Pfad zur Claude-Executable |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Anzahl der Beobachtungen, die bei SessionStart eingefügt werden |

**Einstellungsverwaltung:**

```bash
# Einstellungen über CLI-Helfer bearbeiten
./claude-mem-settings.sh

# Oder direkt bearbeiten
nano ~/.claude-mem/settings.json

# Aktuelle Einstellungen anzeigen
curl http://localhost:37777/api/settings
```

**Format der Einstellungsdatei:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

Siehe [Konfigurationsanleitung](https://docs.claude-mem.ai/configuration) für Details.

---

## Entwicklung

```bash
# Klonen und erstellen
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# Tests ausführen
npm test

# Worker starten
npm run worker:start

# Logs anzeigen
npm run worker:logs
```

Siehe [Entwicklungshandbuch](https://docs.claude-mem.ai/development) für detaillierte Anweisungen.

---

## Fehlerbehebung

**Schnelldiagnose:**

Wenn Sie Probleme haben, beschreiben Sie das Problem Claude und der troubleshoot Skill wird automatisch aktiviert, um zu diagnostizieren und Lösungen bereitzustellen.

**Häufige Probleme:**

- Worker startet nicht → `npm run worker:restart`
- Kein Kontext erscheint → `npm run test:context`
- Datenbankprobleme → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Suche funktioniert nicht → Prüfen Sie, ob FTS5-Tabellen existieren

Siehe [Fehlerbehebungsanleitung](https://docs.claude-mem.ai/troubleshooting) für vollständige Lösungen.

---

## Beitragen

Beiträge sind willkommen! Bitte:

1. Forken Sie das Repository
2. Erstellen Sie einen Feature-Branch
3. Nehmen Sie Ihre Änderungen mit Tests vor
4. Aktualisieren Sie die Dokumentation
5. Reichen Sie einen Pull Request ein

Siehe [Entwicklungshandbuch](https://docs.claude-mem.ai/development) für Beitrags-Workflow.

---

## Lizenz

Dieses Projekt ist unter der **GNU Affero General Public License v3.0** (AGPL-3.0) lizenziert.

Copyright (C) 2025 Alex Newman (@thedotmack). Alle Rechte vorbehalten.

Siehe die [LICENSE](LICENSE) Datei für vollständige Details.

**Was das bedeutet:**

- Sie können diese Software frei verwenden, modifizieren und verteilen
- Wenn Sie sie modifizieren und auf einem Netzwerkserver bereitstellen, müssen Sie Ihren Quellcode verfügbar machen
- Abgeleitete Werke müssen ebenfalls unter AGPL-3.0 lizenziert werden
- Es gibt KEINE GARANTIE für diese Software

---

## Support

- **Dokumentation**: [docs/](docs/)
- **Probleme**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Autor**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Erstellt mit Claude Agent SDK** | **Angetrieben von Claude Code** | **Gemacht mit TypeScript**