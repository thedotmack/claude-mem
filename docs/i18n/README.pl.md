🌐 To jest tłumaczenie automatyczne. Korekty od społeczności są mile widziane!

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

<h4 align="center">System trwałej kompresji pamięci zbudowany dla <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#szybki-start">Szybki Start</a> •
  <a href="#jak-to-działa">Jak To Działa</a> •
  <a href="#narzędzia-wyszukiwania">Narzędzia Wyszukiwania</a> •
  <a href="#dokumentacja">Dokumentacja</a> •
  <a href="#konfiguracja">Konfiguracja</a> •
  <a href="#rozwiązywanie-problemów">Rozwiązywanie Problemów</a> •
  <a href="#licencja">Licencja</a>
</p>

<p align="center">
  Claude-Mem płynnie zachowuje kontekst między sesjami poprzez automatyczne przechwytywanie obserwacji użycia narzędzi, generowanie semantycznych podsumowań i udostępnianie ich przyszłym sesjom. To umożliwia Claude utrzymanie ciągłości wiedzy o projektach nawet po zakończeniu lub ponownym połączeniu sesji.
</p>

---

## Szybki Start

Rozpocznij nową sesję Claude Code w terminalu i wprowadź następujące polecenia:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Uruchom ponownie Claude Code. Kontekst z poprzednich sesji automatycznie pojawi się w nowych sesjach.

**Kluczowe Funkcje:**

- 🧠 **Trwała Pamięć** - Kontekst przetrwa między sesjami
- 📊 **Progresywne Ujawnianie** - Warstwowe pobieranie pamięci z widocznością kosztów tokenów
- 🔍 **Wyszukiwanie Oparte na Umiejętnościach** - Przeszukuj historię projektu za pomocą umiejętności mem-search (~2,250 tokenów oszczędności)
- 🖥️ **Interfejs Przeglądarki Web** - Strumień pamięci w czasie rzeczywistym na http://localhost:37777
- 🔒 **Kontrola Prywatności** - Użyj tagów `<private>`, aby wykluczyć wrażliwą treść z przechowywania
- ⚙️ **Konfiguracja Kontekstu** - Szczegółowa kontrola nad tym, jaki kontekst jest wstrzykiwany
- 🤖 **Automatyczne Działanie** - Nie wymaga ręcznej interwencji
- 🔗 **Cytowania** - Odwołuj się do wcześniejszych decyzji za pomocą URI `claude-mem://`
- 🧪 **Kanał Beta** - Wypróbuj funkcje eksperymentalne, takie jak Endless Mode, poprzez zmianę wersji

---

## Dokumentacja

📚 **[Zobacz Pełną Dokumentację](docs/)** - Przeglądaj dokumentację markdown na GitHub

💻 **Podgląd Lokalny**: Uruchom dokumentację Mintlify lokalnie:

```bash
cd docs
npx mintlify dev
```

### Rozpoczęcie Pracy

- **[Przewodnik Instalacji](https://docs.claude-mem.ai/installation)** - Szybki start i zaawansowana instalacja
- **[Przewodnik Użytkowania](https://docs.claude-mem.ai/usage/getting-started)** - Jak Claude-Mem działa automatycznie
- **[Narzędzia Wyszukiwania](https://docs.claude-mem.ai/usage/search-tools)** - Przeszukuj historię projektu językiem naturalnym
- **[Funkcje Beta](https://docs.claude-mem.ai/beta-features)** - Wypróbuj funkcje eksperymentalne, takie jak Endless Mode

### Najlepsze Praktyki

- **[Inżynieria Kontekstu](https://docs.claude-mem.ai/context-engineering)** - Zasady optymalizacji kontekstu agenta AI
- **[Progresywne Ujawnianie](https://docs.claude-mem.ai/progressive-disclosure)** - Filozofia strategii przygotowywania kontekstu w Claude-Mem

### Architektura

- **[Przegląd](https://docs.claude-mem.ai/architecture/overview)** - Komponenty systemu i przepływ danych
- **[Ewolucja Architektury](https://docs.claude-mem.ai/architecture-evolution)** - Podróż od v3 do v5
- **[Architektura Hooków](https://docs.claude-mem.ai/hooks-architecture)** - Jak Claude-Mem używa hooków cyklu życia
- **[Dokumentacja Hooków](https://docs.claude-mem.ai/architecture/hooks)** - 7 skryptów hooków wyjaśnionych
- **[Serwis Worker](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API i zarządzanie PM2
- **[Baza Danych](https://docs.claude-mem.ai/architecture/database)** - Schemat SQLite i wyszukiwanie FTS5
- **[Architektura Wyszukiwania](https://docs.claude-mem.ai/architecture/search-architecture)** - Hybrydowe wyszukiwanie z bazą wektorową Chroma

### Konfiguracja i Rozwój

- **[Konfiguracja](https://docs.claude-mem.ai/configuration)** - Zmienne środowiskowe i ustawienia
- **[Rozwój](https://docs.claude-mem.ai/development)** - Budowanie, testowanie, współtworzenie
- **[Rozwiązywanie Problemów](https://docs.claude-mem.ai/troubleshooting)** - Typowe problemy i rozwiązania

---

## Jak To Działa

```
┌─────────────────────────────────────────────────────────────┐
│ Start Sesji → Wstrzyknij ostatnie obserwacje jako kontekst  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Zapytania Użytkownika → Utwórz sesję, zapisz zapytania      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Wykonania Narzędzi → Przechwytuj obserwacje (Read, Write)   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Procesy Worker → Wyciągaj wnioski poprzez Claude Agent SDK  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Koniec Sesji → Wygeneruj podsumowanie, gotowe na następną   │
└─────────────────────────────────────────────────────────────┘
```

**Główne Komponenty:**

1. **5 Hooków Cyklu Życia** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 skryptów hooków)
2. **Inteligentna Instalacja** - Buforowany sprawdzacz zależności (skrypt pre-hook, nie hook cyklu życia)
3. **Serwis Worker** - HTTP API na porcie 37777 z interfejsem przeglądarki web i 10 endpointami wyszukiwania, zarządzany przez PM2
4. **Baza Danych SQLite** - Przechowuje sesje, obserwacje, podsumowania z wyszukiwaniem pełnotekstowym FTS5
5. **Umiejętność mem-search** - Zapytania w języku naturalnym z progresywnym ujawnianiem (~2,250 tokenów oszczędności vs MCP)
6. **Baza Wektorowa Chroma** - Hybrydowe wyszukiwanie semantyczne + słów kluczowych dla inteligentnego pobierania kontekstu

Zobacz [Przegląd Architektury](https://docs.claude-mem.ai/architecture/overview) po szczegóły.

---

## Narzędzia Wyszukiwania

Claude-Mem zapewnia inteligentne wyszukiwanie poprzez umiejętność mem-search, która automatycznie włącza się, gdy pytasz o wcześniejszą pracę:

**Jak To Działa:**
- Po prostu pytaj naturalnie: *"Co robiliśmy ostatniej sesji?"* lub *"Czy naprawialiśmy już ten błąd?"*
- Claude automatycznie wywołuje umiejętność mem-search, aby znaleźć odpowiedni kontekst
- ~2,250 tokenów oszczędności na początek sesji vs podejście MCP

**Dostępne Operacje Wyszukiwania:**

1. **Search Observations** - Wyszukiwanie pełnotekstowe w obserwacjach
2. **Search Sessions** - Wyszukiwanie pełnotekstowe w podsumowaniach sesji
3. **Search Prompts** - Wyszukiwanie surowych zapytań użytkowników
4. **By Concept** - Znajdź według tagów koncepcji (discovery, problem-solution, pattern, itp.)
5. **By File** - Znajdź obserwacje odnoszące się do konkretnych plików
6. **By Type** - Znajdź według typu (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Pobierz ostatni kontekst sesji dla projektu
8. **Timeline** - Pobierz zunifikowaną oś czasu kontekstu wokół konkretnego punktu w czasie
9. **Timeline by Query** - Wyszukaj obserwacje i pobierz kontekst osi czasu wokół najlepszego dopasowania
10. **API Help** - Pobierz dokumentację API wyszukiwania

**Przykładowe Zapytania w Języku Naturalnym:**

```
"Jakie błędy naprawiliśmy ostatniej sesji?"
"Jak zaimplementowaliśmy uwierzytelnianie?"
"Jakie zmiany zostały wprowadzone do worker-service.ts?"
"Pokaż mi ostatnią pracę nad tym projektem"
"Co się działo, gdy dodaliśmy interfejs przeglądarki?"
```

Zobacz [Przewodnik Narzędzi Wyszukiwania](https://docs.claude-mem.ai/usage/search-tools) po szczegółowe przykłady.

---

## Funkcje Beta i Endless Mode

Claude-Mem oferuje **kanał beta** z funkcjami eksperymentalnymi. Przełączaj się między stabilnymi a beta wersjami bezpośrednio z interfejsu przeglądarki web.

### Jak Wypróbować Beta

1. Otwórz http://localhost:37777
2. Kliknij Ustawienia (ikona koła zębatego)
3. W **Version Channel** kliknij "Try Beta (Endless Mode)"
4. Poczekaj na restart workera

Twoje dane pamięci są zachowane przy zmianie wersji.

### Endless Mode (Beta)

Flagową funkcją beta jest **Endless Mode** - biomimetyczna architektura pamięci, która dramatycznie wydłuża długość sesji:

**Problem**: Standardowe sesje Claude Code osiągają limity kontekstu po ~50 użyciach narzędzi. Każde narzędzie dodaje 1-10k+ tokenów, a Claude ponownie syntetyzuje wszystkie poprzednie wyjścia przy każdej odpowiedzi (złożoność O(N²)).

**Rozwiązanie**: Endless Mode kompresuje wyjścia narzędzi do ~500-tokenowych obserwacji i transformuje transkrypt w czasie rzeczywistym:

```
Pamięć Robocza (Kontekst):    Skompresowane obserwacje (~500 tokenów każda)
Pamięć Archiwum (Dysk):        Pełne wyjścia narzędzi zachowane do przywołania
```

**Oczekiwane Rezultaty**:
- ~95% redukcja tokenów w oknie kontekstu
- ~20x więcej użyć narzędzi przed wyczerpaniem kontekstu
- Skalowanie liniowe O(N) zamiast kwadratowego O(N²)
- Pełne transkrypty zachowane dla doskonałego przypomnienia

**Zastrzeżenia**: Dodaje opóźnienie (60-90s na narzędzie dla generowania obserwacji), wciąż eksperymentalne.

Zobacz [Dokumentację Funkcji Beta](https://docs.claude-mem.ai/beta-features) po szczegóły.

---

## Co Nowego

**v6.4.9 - Ustawienia Konfiguracji Kontekstu:**
- 11 nowych ustawień dla szczegółowej kontroli nad wstrzykiwaniem kontekstu
- Konfiguruj wyświetlanie ekonomii tokenów, filtrowanie obserwacji według typu/koncepcji
- Kontroluj liczbę obserwacji i które pola wyświetlać

**v6.4.0 - Dwutagowy System Prywatności:**
- Tagi `<private>` dla prywatności kontrolowanej przez użytkownika - owijaj wrażliwą treść, aby wykluczyć z przechowywania
- Systemowe tagi `<claude-mem-context>` zapobiegają rekurencyjnemu przechowywaniu obserwacji
- Przetwarzanie brzegowe zapewnia, że prywatna treść nigdy nie dociera do bazy danych

**v6.3.0 - Kanał Wersji:**
- Przełączaj się między stabilnymi a beta wersjami z interfejsu przeglądarki web
- Wypróbuj funkcje eksperymentalne, takie jak Endless Mode, bez ręcznych operacji git

**Wcześniejsze Najważniejsze Zmiany:**
- **v6.0.0**: Główne ulepszenia zarządzania sesjami i przetwarzania transkryptów
- **v5.5.0**: Ulepszenie umiejętności mem-search ze 100% skutecznością
- **v5.4.0**: Architektura wyszukiwania oparta na umiejętnościach (~2,250 tokenów oszczędzone na sesję)
- **v5.1.0**: Interfejs przeglądarki oparty na web z aktualizacjami w czasie rzeczywistym
- **v5.0.0**: Hybrydowe wyszukiwanie z bazą wektorową Chroma

Zobacz [CHANGELOG.md](CHANGELOG.md) po pełną historię wersji.

---

## Wymagania Systemowe

- **Node.js**: 18.0.0 lub wyższa
- **Claude Code**: Najnowsza wersja ze wsparciem wtyczek
- **PM2**: Menedżer procesów (dołączony - nie wymaga globalnej instalacji)
- **SQLite 3**: Do trwałego przechowywania (dołączony)

---

## Kluczowe Korzyści

### Progresywne Ujawnianie Kontekstu

- **Warstwowe pobieranie pamięci** odzwierciedla ludzkie wzorce pamięci
- **Warstwa 1 (Indeks)**: Zobacz, jakie obserwacje istnieją wraz z kosztami tokenów na początku sesji
- **Warstwa 2 (Szczegóły)**: Pobieraj pełne narracje na żądanie poprzez wyszukiwanie MCP
- **Warstwa 3 (Doskonałe Przypomnienie)**: Dostęp do kodu źródłowego i oryginalnych transkryptów
- **Inteligentne podejmowanie decyzji**: Liczby tokenów pomagają Claude wybrać między pobieraniem szczegółów a czytaniem kodu
- **Wskaźniki typu**: Wizualne wskazówki (🔴 krytyczne, 🟤 decyzja, 🔵 informacyjne) podkreślają wagę obserwacji

### Automatyczna Pamięć

- Kontekst automatycznie wstrzykiwany, gdy Claude się uruchamia
- Nie wymaga ręcznych poleceń ani konfiguracji
- Działa przezroczyście w tle

### Wyszukiwanie Pełnej Historii

- Przeszukuj wszystkie sesje i obserwacje
- Wyszukiwanie pełnotekstowe FTS5 dla szybkich zapytań
- Cytowania prowadzą z powrotem do konkretnych obserwacji

### Strukturyzowane Obserwacje

- Wydobywanie wniosków wspierane przez AI
- Kategoryzowane według typu (decision, bugfix, feature, itp.)
- Otagowane koncepcjami i odwołaniami do plików

### Sesje Wielozapytaniowe

- Sesje obejmują wiele zapytań użytkownika
- Kontekst zachowany między poleceniami `/clear`
- Śledź całe wątki konwersacji

---

## Konfiguracja

Ustawienia są zarządzane w `~/.claude-mem/settings.json`. Plik jest automatycznie tworzony z domyślnymi wartościami przy pierwszym uruchomieniu.

**Dostępne Ustawienia:**

| Ustawienie | Domyślnie | Opis |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | Model AI dla obserwacji |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | Port serwisu worker |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | Lokalizacja katalogu danych |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | Szczegółowość logów (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | Wersja Python dla chroma-mcp |
| `CLAUDE_CODE_PATH` | _(auto-wykryj)_ | Ścieżka do pliku wykonywalnego Claude |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Liczba obserwacji do wstrzyknięcia przy SessionStart |

**Zarządzanie Ustawieniami:**

```bash
# Edytuj ustawienia przez pomocnika CLI
./claude-mem-settings.sh

# Lub edytuj bezpośrednio
nano ~/.claude-mem/settings.json

# Zobacz bieżące ustawienia
curl http://localhost:37777/api/settings
```

**Format Pliku Ustawień:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

Zobacz [Przewodnik Konfiguracji](https://docs.claude-mem.ai/configuration) po szczegóły.

---

## Rozwój

```bash
# Sklonuj i zbuduj
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# Uruchom testy
npm test

# Uruchom worker
npm run worker:start

# Zobacz logi
npm run worker:logs
```

Zobacz [Przewodnik Rozwoju](https://docs.claude-mem.ai/development) po szczegółowe instrukcje.

---

## Rozwiązywanie Problemów

**Szybka Diagnostyka:**

Jeśli napotkasz problemy, opisz problem Claude, a umiejętność troubleshoot automatycznie się aktywuje, aby zdiagnozować i dostarczyć poprawki.

**Typowe Problemy:**

- Worker się nie uruchamia → `npm run worker:restart`
- Kontekst się nie pojawia → `npm run test:context`
- Problemy z bazą danych → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Wyszukiwanie nie działa → Sprawdź, czy tabele FTS5 istnieją

Zobacz [Przewodnik Rozwiązywania Problemów](https://docs.claude-mem.ai/troubleshooting) po pełne rozwiązania.

---

## Współtworzenie

Wkład jest mile widziany! Proszę:

1. Forkuj repozytorium
2. Utwórz gałąź funkcji
3. Wprowadź zmiany z testami
4. Zaktualizuj dokumentację
5. Prześlij Pull Request

Zobacz [Przewodnik Rozwoju](https://docs.claude-mem.ai/development) po workflow współtworzenia.

---

## Licencja

Ten projekt jest licencjonowany na **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Wszelkie prawa zastrzeżone.

Zobacz plik [LICENSE](LICENSE) po pełne szczegóły.

**Co To Oznacza:**

- Możesz używać, modyfikować i dystrybuować to oprogramowanie swobodnie
- Jeśli modyfikujesz i wdrażasz na serwerze sieciowym, musisz udostępnić swój kod źródłowy
- Prace pochodne muszą być również licencjonowane na AGPL-3.0
- NIE MA GWARANCJI dla tego oprogramowania

---

## Wsparcie

- **Dokumentacja**: [docs/](docs/)
- **Problemy**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repozytorium**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Autor**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Zbudowane z Claude Agent SDK** | **Napędzane przez Claude Code** | **Stworzone z TypeScript**