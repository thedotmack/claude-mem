🌐 Это автоматический перевод. Приветствуются исправления от сообщества!

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

<h4 align="center">Система сжатия постоянной памяти, созданная для <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#быстрый-старт">Быстрый старт</a> •
  <a href="#как-это-работает">Как это работает</a> •
  <a href="#инструменты-поиска-mcp">Инструменты поиска</a> •
  <a href="#документация">Документация</a> •
  <a href="#конфигурация">Конфигурация</a> •
  <a href="#устранение-неполадок">Устранение неполадок</a> •
  <a href="#лицензия">Лицензия</a>
</p>

<p align="center">
  Claude-Mem бесшовно сохраняет контекст между сеансами, автоматически фиксируя наблюдения за использованием инструментов, генерируя семантические сводки и делая их доступными для будущих сеансов. Это позволяет Claude поддерживать непрерывность знаний о проектах даже после завершения или переподключения сеансов.
</p>

---

## Быстрый старт

Запустите новый сеанс Claude Code в терминале и введите следующие команды:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Перезапустите Claude Code. Контекст из предыдущих сеансов будет автоматически появляться в новых сеансах.

**Ключевые возможности:**

- 🧠 **Постоянная память** - Контекст сохраняется между сеансами
- 📊 **Прогрессивное раскрытие** - Многоуровневое извлечение памяти с видимостью стоимости токенов
- 🔍 **Поиск на основе навыков** - Запросы к истории проекта с помощью навыка mem-search
- 🖥️ **Веб-интерфейс просмотра** - Поток памяти в реальном времени на http://localhost:37777
- 💻 **Навык для Claude Desktop** - Поиск в памяти из разговоров Claude Desktop
- 🔒 **Контроль конфиденциальности** - Используйте теги `<private>` для исключения конфиденциального контента из хранилища
- ⚙️ **Настройка контекста** - Детальный контроль того, какой контекст внедряется
- 🤖 **Автоматическая работа** - Не требуется ручное вмешательство
- 🔗 **Цитирование** - Ссылки на прошлые наблюдения с помощью ID (доступ через http://localhost:37777/api/observation/{id} или просмотр всех в веб-интерфейсе на http://localhost:37777)
- 🧪 **Бета-канал** - Попробуйте экспериментальные функции, такие как режим Endless, переключая версии

---

## Документация

📚 **[Просмотреть полную документацию](https://docs.claude-mem.ai/)** - Просмотр на официальном сайте

### Начало работы

- **[Руководство по установке](https://docs.claude-mem.ai/installation)** - Быстрый старт и продвинутая установка
- **[Руководство по использованию](https://docs.claude-mem.ai/usage/getting-started)** - Как Claude-Mem работает автоматически
- **[Инструменты поиска](https://docs.claude-mem.ai/usage/search-tools)** - Запросы к истории проекта на естественном языке
- **[Бета-функции](https://docs.claude-mem.ai/beta-features)** - Попробуйте экспериментальные функции, такие как режим Endless

### Лучшие практики

- **[Инженерия контекста](https://docs.claude-mem.ai/context-engineering)** - Принципы оптимизации контекста для AI-агентов
- **[Прогрессивное раскрытие](https://docs.claude-mem.ai/progressive-disclosure)** - Философия стратегии подготовки контекста в Claude-Mem

### Архитектура

- **[Обзор](https://docs.claude-mem.ai/architecture/overview)** - Компоненты системы и поток данных
- **[Эволюция архитектуры](https://docs.claude-mem.ai/architecture-evolution)** - Путь от v3 к v5
- **[Архитектура хуков](https://docs.claude-mem.ai/hooks-architecture)** - Как Claude-Mem использует хуки жизненного цикла
- **[Справочник по хукам](https://docs.claude-mem.ai/architecture/hooks)** - Объяснение 7 скриптов хуков
- **[Сервис Worker](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API и управление Bun
- **[База данных](https://docs.claude-mem.ai/architecture/database)** - Схема SQLite и поиск FTS5
- **[Архитектура поиска](https://docs.claude-mem.ai/architecture/search-architecture)** - Гибридный поиск с векторной базой данных Chroma

### Конфигурация и разработка

- **[Конфигурация](https://docs.claude-mem.ai/configuration)** - Переменные окружения и настройки
- **[Разработка](https://docs.claude-mem.ai/development)** - Сборка, тестирование, участие в разработке
- **[Устранение неполадок](https://docs.claude-mem.ai/troubleshooting)** - Распространенные проблемы и решения

---

## Как это работает

**Основные компоненты:**

1. **5 хуков жизненного цикла** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 скриптов хуков)
2. **Умная установка** - Проверка кешированных зависимостей (скрипт предварительного хука, не является хуком жизненного цикла)
3. **Сервис Worker** - HTTP API на порту 37777 с веб-интерфейсом просмотра и 10 конечными точками поиска, управляемый Bun
4. **База данных SQLite** - Хранит сеансы, наблюдения, сводки
5. **Навык mem-search** - Запросы на естественном языке с прогрессивным раскрытием
6. **Векторная база данных Chroma** - Гибридный семантический + ключевой поиск для интеллектуального извлечения контекста

Подробности см. в [Обзоре архитектуры](https://docs.claude-mem.ai/architecture/overview).

---

## Навык mem-search

Claude-Mem предоставляет интеллектуальный поиск через навык mem-search, который автоматически вызывается, когда вы спрашиваете о прошлой работе:

**Как это работает:**
- Просто спросите естественно: *"Что мы делали в прошлом сеансе?"* или *"Мы исправляли этот баг раньше?"*
- Claude автоматически вызывает навык mem-search для поиска релевантного контекста

**Доступные операции поиска:**

1. **Поиск наблюдений** - Полнотекстовый поиск по наблюдениям
2. **Поиск сеансов** - Полнотекстовый поиск по сводкам сеансов
3. **Поиск запросов** - Поиск исходных пользовательских запросов
4. **По концепции** - Поиск по тегам концепций (discovery, problem-solution, pattern и т.д.)
5. **По файлу** - Поиск наблюдений, ссылающихся на конкретные файлы
6. **По типу** - Поиск по типу (decision, bugfix, feature, refactor, discovery, change)
7. **Недавний контекст** - Получение недавнего контекста сеанса для проекта
8. **Хронология** - Получение единой хронологии контекста вокруг определенного момента времени
9. **Хронология по запросу** - Поиск наблюдений и получение контекста хронологии вокруг наилучшего совпадения
10. **Справка по API** - Получение документации по API поиска

**Примеры запросов на естественном языке:**

```
"Какие баги мы исправили в прошлом сеансе?"
"Как мы реализовали аутентификацию?"
"Какие изменения были внесены в worker-service.ts?"
"Покажи недавнюю работу над этим проектом"
"Что происходило, когда мы добавляли интерфейс просмотра?"
```

Подробные примеры см. в [Руководстве по инструментам поиска](https://docs.claude-mem.ai/usage/search-tools).

---

## Бета-функции

Claude-Mem предлагает **бета-канал** с экспериментальными функциями, такими как **режим Endless** (биомиметическая архитектура памяти для расширенных сеансов). Переключайтесь между стабильной и бета-версиями из веб-интерфейса на http://localhost:37777 → Settings.

Подробности о режиме Endless и способах его опробовать см. в **[Документации по бета-функциям](https://docs.claude-mem.ai/beta-features)**.

---

## Системные требования

- **Node.js**: 18.0.0 или выше
- **Claude Code**: Последняя версия с поддержкой плагинов
- **Bun**: Среда выполнения JavaScript и менеджер процессов (автоматически устанавливается при отсутствии)
- **uv**: Менеджер пакетов Python для векторного поиска (автоматически устанавливается при отсутствии)
- **SQLite 3**: Для постоянного хранения (встроенный)

---

## Конфигурация

Настройки управляются в `~/.claude-mem/settings.json` (автоматически создается с настройками по умолчанию при первом запуске). Настройте AI-модель, порт worker, директорию данных, уровень логирования и параметры внедрения контекста.

Все доступные настройки и примеры см. в **[Руководстве по конфигурации](https://docs.claude-mem.ai/configuration)**.

---

## Разработка

Инструкции по сборке, тестированию и процессу участия в разработке см. в **[Руководстве по разработке](https://docs.claude-mem.ai/development)**.

---

## Устранение неполадок

При возникновении проблем опишите проблему Claude, и навык устранения неполадок автоматически выполнит диагностику и предоставит исправления.

Распространенные проблемы и решения см. в **[Руководстве по устранению неполадок](https://docs.claude-mem.ai/troubleshooting)**.

---

## Отчеты об ошибках

Создавайте подробные отчеты об ошибках с помощью автоматического генератора:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Участие в разработке

Приветствуются вклады! Пожалуйста:

1. Форкните репозиторий
2. Создайте ветку для функции
3. Внесите изменения с тестами
4. Обновите документацию
5. Отправьте Pull Request

Процесс участия см. в [Руководстве по разработке](https://docs.claude-mem.ai/development).

---

## License

This project is licensed under the **Apache License 2.0** (Apache-2.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

Apache-2.0 allows broad use, modification, distribution, and commercial use, subject to its terms.

**Ragtime note**: The ragtime/ directory is licensed under the **Apache License 2.0**. See [ragtime/LICENSE](ragtime/LICENSE) for details.

---


## Поддержка

- **Документация**: [docs/](docs/)
- **Проблемы**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Репозиторий**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Автор**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Создано с помощью Claude Agent SDK** | **Работает на Claude Code** | **Сделано на TypeScript**