🌐 Это перевод, поддерживаемый сообществом. Исправления приветствуются!

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

<h4 align="center">Система сжатия постоянной памяти, созданная для <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#quick-start">Быстрый старт</a> •
  <a href="#how-it-works">Как это работает</a> •
  <a href="#mcp-search-tools">Инструменты поиска</a> •
  <a href="#documentation">Документация</a> •
  <a href="#configuration">Настройка</a> •
  <a href="#troubleshooting">Устранение неполадок</a> •
  <a href="#license">Лицензия</a>
</p>

<p align="center">
  Claude-Mem без проблем сохраняет контекст между сессиями, автоматически фиксируя наблюдения использования инструментов, создавая семантические сводки и делая их доступными для будущих сессий. Это позволяет Claude сохранять непрерывность знаний о проектах даже после завершения или переподключения сессий.
</p>

---

## Быстрый старт

Установите одной командой:

```bash
npx claude-mem install
```

Или установите для Gemini CLI (автоматически определяет `~/.gemini`):

```bash
npx claude-mem install --ide gemini-cli
```
Или установите для OpenCode:

```bash
npx claude-mem install --ide opencode
```

Или установите из marketplace плагинов в Claude Code:

```bash
/plugin marketplace add thedotmack/claude-mem

/plugin install claude-mem
```

Перезапустите Claude Code или Gemini CLI. Контекст из предыдущих сессий автоматически появится в новых сессиях.

> **Примечание:** Claude-Mem также опубликован на npm, но `npm install -g claude-mem` устанавливает **только SDK/библиотеку** — он не регистрирует хуки плагина и не настраивает worker-сервис. Всегда устанавливайте через `npx claude-mem install` или команды `/plugin` выше.

### 🦞 OpenClaw Gateway

Установите claude-mem как плагин постоянной памяти на шлюзах [OpenClaw](https://openclaw.ai) одной командой:

```bash
curl -fsSL https://install.cmem.ai/openclaw.sh | bash
```

Установщик обрабатывает зависимости, настройку плагина, конфигурацию AI-провайдера, запуск worker и опциональные потоки наблюдений в реальном времени в Telegram, Discord, Slack и др. Подробности см. в [Руководстве по интеграции OpenClaw](https://docs.claude-mem.ai/openclaw-integration).

**Ключевые возможности:**

- 🧠 **Постоянная память** - Контекст сохраняется между сессиями
- 📊 **Постепенное раскрытие** - Многоуровневое извлечение памяти с видимостью стоимости токенов
- 🔍 **Поиск на основе skills** - Запрашивайте историю проекта с помощью skill mem-search
- 🖥️ **Веб-интерфейс** - Поток памяти в реальном времени на http://localhost:37777
- 💻 **Skill Claude Desktop** - Ищите в памяти из разговоров Claude Desktop
- 🔒 **Контроль конфиденциальности** - Используйте теги `<private>`, чтобы исключить конфиденциальный контент из хранилища
- ⚙️ **Настройка контекста** - Тонкий контроль над тем, какой контекст внедряется
- 🤖 **Автоматическая работа** - Не требует ручного вмешательства
- 🔗 **Цитирование** - Ссылайтесь на прошлые наблюдения по ID (доступ через http://localhost:37777/api/observation/{id} или просмотр всех в веб-интерфейсе на http://localhost:37777)
- 🧪 **Beta-канал** - Пробуйте экспериментальные функции, такие как Endless Mode, переключая версии

---

## Документация

📚 **[Просмотреть полную документацию](https://docs.claude-mem.ai/)** - На официальном сайте

### Начало работы

- **[Руководство по установке](https://docs.claude-mem.ai/installation)** - Быстрый старт и расширенная установка
- **[Настройка Gemini CLI](https://docs.claude-mem.ai/gemini-cli/setup)** - Отдельное руководство по интеграции с Gemini CLI от Google
- **[Руководство по использованию](https://docs.claude-mem.ai/usage/getting-started)** - Как Claude-Mem работает автоматически
- **[Инструменты поиска](https://docs.claude-mem.ai/usage/search-tools)** - Запрашивайте историю проекта на естественном языке
- **[Beta-функции](https://docs.claude-mem.ai/beta-features)** - Пробуйте экспериментальные функции, такие как Endless Mode

### Лучшие практики

- **[Инженерия контекста](https://docs.claude-mem.ai/context-engineering)** - Принципы оптимизации контекста AI-агентов
- **[Постепенное раскрытие](https://docs.claude-mem.ai/progressive-disclosure)** - Философия стратегии подготовки контекста Claude-Mem

### Архитектура

- **[Обзор](https://docs.claude-mem.ai/architecture/overview)** - Компоненты системы и поток данных
- **[Эволюция архитектуры](https://docs.claude-mem.ai/architecture-evolution)** - Путь от v3 к v5
- **[Архитектура hooks](https://docs.claude-mem.ai/hooks-architecture)** - Как Claude-Mem использует lifecycle hooks
- **[Справочник hooks](https://docs.claude-mem.ai/architecture/hooks)** - Описание 7 hook-скриптов
- **[Worker-сервис](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API и управление через Bun
- **[База данных](https://docs.claude-mem.ai/architecture/database)** - Схема SQLite и поиск FTS5
- **[Архитектура поиска](https://docs.claude-mem.ai/architecture/search-architecture)** - Гибридный поиск с векторной БД Chroma

### Настройка и разработка

- **[Настройка](https://docs.claude-mem.ai/configuration)** - Переменные окружения и параметры
- **[Разработка](https://docs.claude-mem.ai/development)** - Сборка, тестирование, участие
- **[Устранение неполадок](https://docs.claude-mem.ai/troubleshooting)** - Распространённые проблемы и решения

---

## Как это работает

**Основные компоненты:**

1. **5 lifecycle hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook-скриптов)
2. **Smart Install** - Кэшируемый проверщик зависимостей (pre-hook скрипт, не lifecycle hook)
3. **Worker-сервис** - HTTP API на порту 37777 с веб-интерфейсом и 10 search endpoints, управляется Bun
4. **База данных SQLite** - Хранит сессии, наблюдения, сводки
5. **Skill mem-search** - Запросы на естественном языке с постепенным раскрытием
6. **Векторная БД Chroma** - Гибридный семантический + ключевой поиск для интеллектуального извлечения контекста

Подробности см. в [Обзоре архитектуры](https://docs.claude-mem.ai/architecture/overview).

---

## MCP-инструменты поиска

Claude-Mem обеспечивает интеллектуальный поиск по памяти через **4 MCP-инструмента**, следуя **3-уровневому рабочему процессу**, экономящему токены:

**3-уровневый рабочий процесс:**

1. **`search`** - Получите компактный индекс с ID (~50-100 tokens/результат)
2. **`timeline`** - Получите хронологический контекст вокруг интересных результатов
3. **`get_observations`** - Получите полные детали ТОЛЬКО для отфильтрованных ID (~500-1 000 tokens/результат)

**Как это работает:**
- Claude использует MCP-инструменты для поиска в вашей памяти
- Начните с `search`, чтобы получить индекс результатов
- Используйте `timeline`, чтобы увидеть, что происходило вокруг конкретных наблюдений
- Используйте `get_observations`, чтобы получить полные детали для релевантных ID
- **~10x экономия токенов** за счёт фильтрации перед получением деталей

**Доступные MCP-инструменты:**

1. **`search`** - Поиск по индексу памяти с полнотекстовыми запросами, фильтры по типу/дате/проекту
2. **`timeline`** - Получение хронологического контекста вокруг конкретного наблюдения или запроса
3. **`get_observations`** - Получение полных деталей наблюдений по ID (всегда группируйте несколько ID)

**Пример использования:**

```typescript
// Step 1: Search for index
search(query="authentication bug", type="bugfix", limit=10)

// Step 2: Review index, identify relevant IDs (e.g., #123, #456)

// Step 3: Fetch full details
get_observations(ids=[123, 456])
```

Подробные примеры см. в [Руководстве по инструментам поиска](https://docs.claude-mem.ai/usage/search-tools).

---

## Beta-функции

Claude-Mem предлагает **beta-канал** с экспериментальными функциями, такими как **Endless Mode** (биомиметическая архитектура памяти для длительных сессий). Переключайтесь между стабильной и beta-версиями в веб-интерфейсе на http://localhost:37777 → Settings.

Подробности об Endless Mode и способах его использования см. в **[Документации beta-функций](https://docs.claude-mem.ai/beta-features)**.

---

## Системные требования

- **Node.js**: 18.0.0 или выше
- **Claude Code**: Последняя версия с поддержкой плагинов
- **Bun**: JavaScript runtime и менеджер процессов (устанавливается автоматически при отсутствии)
- **uv**: Менеджер Python-пакетов для векторного поиска (устанавливается автоматически при отсутствии)
- **SQLite 3**: Для постоянного хранения (в комплекте)

---
### Заметки по установке в Windows

Если вы видите ошибку вида:

```powershell
npm : The term 'npm' is not recognized as the name of a cmdlet
```

Убедитесь, что Node.js и npm установлены и добавлены в PATH. Скачайте последний установщик Node.js с https://nodejs.org и перезапустите терминал после установки.

---

## Настройка

Настройки управляются в `~/.claude-mem/settings.json` (создаётся автоматически со значениями по умолчанию при первом запуске). Настройте AI-модель, порт worker, каталог данных, уровень логирования и параметры внедрения контекста.

Все доступные настройки и примеры см. в **[Руководстве по настройке](https://docs.claude-mem.ai/configuration)**.

### Настройка режима и языка

Claude-Mem поддерживает несколько режимов рабочего процесса и языков через параметр `CLAUDE_MEM_MODE`.

Эта опция управляет обоими:
- Поведением рабочего процесса (например, code, chill, investigation)
- Языком, используемым в сгенерированных наблюдениях

#### Как настроить

Отредактируйте файл настроек в `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_MODE": "code--zh"
}
```

Режимы определены в `plugin/modes/`. Чтобы увидеть все доступные режимы локально:

```bash
ls ~/.claude/plugins/marketplaces/thedotmack/plugin/modes/
```

#### Доступные режимы

| Mode | Description |
|------------|-------------------------|
| `code` | Режим по умолчанию на английском |
| `code--zh` | Режим упрощённого китайского |
| `code--ja` | Японский режим |

Языковые режимы следуют шаблону `code--[lang]`, где `[lang]` — код языка ISO 639-1 (например, `zh` для китайского, `ja` для японского, `es` для испанского).

> Примечание: `code--zh` (упрощённый китайский) уже встроен — дополнительная установка или обновление плагина не требуется.

#### После изменения режима

Перезапустите Claude Code, чтобы применить новую конфигурацию режима.
---

## Разработка

Инструкции по сборке, тестированию и процессу участия см. в **[Руководстве по разработке](https://docs.claude-mem.ai/development)**.

---

## Устранение неполадок

При возникновении проблем опишите их Claude, и skill troubleshoot автоматически проведёт диагностику и предложит исправления.

Распространённые проблемы и решения см. в **[Руководстве по устранению неполадок](https://docs.claude-mem.ai/troubleshooting)**.

---

## Отчёты об ошибках

Создавайте подробные отчёты об ошибках с помощью автоматического генератора:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Участие

Приветствуются любые вклады! Пожалуйста:

1. Сделайте fork репозитория
2. Создайте feature branch
3. Внесите изменения с тестами
4. Обновите документацию
5. Отправьте Pull Request

Процесс участия см. в [Руководстве по разработке](https://docs.claude-mem.ai/development).

---

## Лицензия

Claude-Mem распространяется под лицензией Apache License 2.0.

Мы выбрали Apache-2.0, потому что постоянная память агентов должна легко встраиваться в
инструменты разработчиков, локальные агенты, MCP-серверы, корпоративные системы, робототехнические стеки
и production agent harnesses.

Полные сведения см. в файле [LICENSE](LICENSE). См. также [docs/license.md](docs/license.md)
и [docs/ip-boundary.md](docs/ip-boundary.md) о scope лицензии и
границе open/commercial.

**Примечание о Ragtime**: Каталог `ragtime/` распространяется под **Apache License 2.0**. Подробности см. в [ragtime/LICENSE](ragtime/LICENSE).

---

## Поддержка

- **Документация**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Репозиторий**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Официальный аккаунт X**: [@Claude_Memory](https://x.com/Claude_Memory)
- **Официальный Discord**: [Присоединиться к Discord](https://discord.com/invite/J4wttp9vDu)
- **Автор**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Создано с Claude Agent SDK** | **Работает с Claude Code** | **Сделано на TypeScript**

---

### А что насчёт $CMEM?

$CMEM — это токен Solana, созданный третьей стороной без предварительного согласия Claude-Mem, но официально принятый создателем Claude-Mem (Alex Newman, @thedotmack). Токен выступает катализатором роста сообщества и средством доставки данных агентов в реальном времени разработчикам и knowledge workers, которым они нужнее всего. $CMEM: 2TsmuYUrsctE57VLckZBYEEzdokUF8j8e1GavekWBAGS
