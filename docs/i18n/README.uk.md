🌐 Це автоматичний переклад. Вітаються виправлення від спільноти!

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

<h4 align="center">Система стиснення постійної пам'яті, створена для <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#швидкий-старт">Швидкий старт</a> •
  <a href="#як-це-працює">Як це працює</a> •
  <a href="#інструменти-пошуку-mcp">Інструменти пошуку</a> •
  <a href="#документація">Документація</a> •
  <a href="#конфігурація">Конфігурація</a> •
  <a href="#усунення-несправностей">Усунення несправностей</a> •
  <a href="#ліцензія">Ліцензія</a>
</p>

<p align="center">
  Claude-Mem безперешкодно зберігає контекст між сесіями, автоматично фіксуючи спостереження за використанням інструментів, генеруючи семантичні резюме та роблячи їх доступними для майбутніх сесій. Це дозволяє Claude підтримувати безперервність знань про проєкти навіть після завершення або повторного підключення сесій.
</p>

---

## Швидкий старт

Розпочніть нову сесію Claude Code у терміналі та введіть наступні команди:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Перезапустіть Claude Code. Контекст з попередніх сесій автоматично з'явиться в нових сесіях.

**Ключові можливості:**

- 🧠 **Постійна пам'ять** - Контекст зберігається між сесіями
- 📊 **Прогресивне розкриття** - Багаторівневе отримання пам'яті з видимістю вартості токенів
- 🔍 **Пошук на основі навичок** - Запитуйте історію свого проєкту за допомогою навички mem-search
- 🖥️ **Веб-інтерфейс перегляду** - Потік пам'яті в реальному часі на http://localhost:37777
- 💻 **Навичка Claude Desktop** - Шукайте в пам'яті з розмов Claude Desktop
- 🔒 **Контроль конфіденційності** - Використовуйте теги `<private>` для виключення чутливого вмісту зі зберігання
- ⚙️ **Конфігурація контексту** - Детальний контроль над тим, який контекст впроваджується
- 🤖 **Автоматична робота** - Не потребує ручного втручання
- 🔗 **Цитування** - Посилайтеся на минулі спостереження за ідентифікаторами (доступ через http://localhost:37777/api/observation/{id} або перегляд усіх у веб-переглядачі на http://localhost:37777)
- 🧪 **Бета-канал** - Спробуйте експериментальні функції, як-от режим Endless Mode, через перемикання версій

---

## Документація

📚 **[Переглянути повну документацію](https://docs.claude-mem.ai/)** - Переглянути на офіційному сайті

### Початок роботи

- **[Посібник з встановлення](https://docs.claude-mem.ai/installation)** - Швидкий старт і розширене встановлення
- **[Посібник з використання](https://docs.claude-mem.ai/usage/getting-started)** - Як Claude-Mem працює автоматично
- **[Інструменти пошуку](https://docs.claude-mem.ai/usage/search-tools)** - Запитуйте історію свого проєкту природною мовою
- **[Бета-функції](https://docs.claude-mem.ai/beta-features)** - Спробуйте експериментальні функції, як-от режим Endless Mode

### Найкращі практики

- **[Інженерія контексту](https://docs.claude-mem.ai/context-engineering)** - Принципи оптимізації контексту AI-агента
- **[Прогресивне розкриття](https://docs.claude-mem.ai/progressive-disclosure)** - Філософія стратегії підготовки контексту Claude-Mem

### Архітектура

- **[Огляд](https://docs.claude-mem.ai/architecture/overview)** - Компоненти системи та потік даних
- **[Еволюція архітектури](https://docs.claude-mem.ai/architecture-evolution)** - Шлях від v3 до v5
- **[Архітектура хуків](https://docs.claude-mem.ai/hooks-architecture)** - Як Claude-Mem використовує хуки життєвого циклу
- **[Довідник хуків](https://docs.claude-mem.ai/architecture/hooks)** - Пояснення 7 скриптів хуків
- **[Сервіс воркера](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API та управління Bun
- **[База даних](https://docs.claude-mem.ai/architecture/database)** - Схема SQLite та пошук FTS5
- **[Архітектура пошуку](https://docs.claude-mem.ai/architecture/search-architecture)** - Гібридний пошук з векторною базою даних Chroma

### Конфігурація та розробка

- **[Конфігурація](https://docs.claude-mem.ai/configuration)** - Змінні середовища та налаштування
- **[Розробка](https://docs.claude-mem.ai/development)** - Збірка, тестування, внесок
- **[Усунення несправностей](https://docs.claude-mem.ai/troubleshooting)** - Поширені проблеми та рішення

---

## Як це працює

**Основні компоненти:**

1. **5 хуків життєвого циклу** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 скриптів хуків)
2. **Розумне встановлення** - Кешована перевірка залежностей (скрипт перед хуком, не хук життєвого циклу)
3. **Сервіс воркера** - HTTP API на порту 37777 з веб-інтерфейсом перегляду та 10 кінцевими точками пошуку, керується Bun
4. **База даних SQLite** - Зберігає сесії, спостереження, резюме
5. **Навичка mem-search** - Запити природною мовою з прогресивним розкриттям
6. **Векторна база даних Chroma** - Гібридний семантичний + ключовий пошук для інтелектуального отримання контексту

Дивіться [Огляд архітектури](https://docs.claude-mem.ai/architecture/overview) для деталей.

---

## Навичка mem-search

Claude-Mem надає інтелектуальний пошук через навичку mem-search, яка автоматично викликається, коли ви запитуєте про минулу роботу:

**Як це працює:**
- Просто запитайте природно: *"Що ми робили в минулій сесії?"* або *"Ми виправляли цю помилку раніше?"*
- Claude автоматично викликає навичку mem-search для пошуку релевантного контексту

**Доступні операції пошуку:**

1. **Пошук спостережень** - Повнотекстовий пошук у спостереженнях
2. **Пошук сесій** - Повнотекстовий пошук у резюме сесій
3. **Пошук запитів** - Пошук необроблених запитів користувачів
4. **За концепцією** - Знайти за тегами концепцій (discovery, problem-solution, pattern тощо)
5. **За файлом** - Знайти спостереження, що посилаються на конкретні файли
6. **За типом** - Знайти за типом (decision, bugfix, feature, refactor, discovery, change)
7. **Останній контекст** - Отримати останній контекст сесії для проєкту
8. **Часова шкала** - Отримати єдину часову шкалу контексту навколо конкретного моменту часу
9. **Часова шкала за запитом** - Шукати спостереження та отримувати контекст часової шкали навколо найкращого збігу
10. **Довідка API** - Отримати документацію API пошуку

**Приклади запитів природною мовою:**

```
"Які помилки ми виправили в минулій сесії?"
"Як ми реалізували автентифікацію?"
"Які зміни були внесені в worker-service.ts?"
"Покажи мені останню роботу над цим проєктом"
"Що відбувалося, коли ми додали інтерфейс перегляду?"
```

Дивіться [Посібник з інструментів пошуку](https://docs.claude-mem.ai/usage/search-tools) для детальних прикладів.

---

## Бета-функції

Claude-Mem пропонує **бета-канал** з експериментальними функціями, як-от **режим Endless Mode** (біоміметична архітектура пам'яті для тривалих сесій). Перемикайтеся між стабільною та бета-версіями з веб-інтерфейсу перегляду на http://localhost:37777 → Налаштування.

Дивіться **[Документацію бета-функцій](https://docs.claude-mem.ai/beta-features)** для деталей про режим Endless Mode та як його спробувати.

---

## Системні вимоги

- **Node.js**: 18.0.0 або вище
- **Claude Code**: Остання версія з підтримкою плагінів
- **Bun**: Середовище виконання JavaScript та менеджер процесів (автоматично встановлюється, якщо відсутнє)
- **uv**: Менеджер пакетів Python для векторного пошуку (автоматично встановлюється, якщо відсутній)
- **SQLite 3**: Для постійного зберігання (у комплекті)

---

## Конфігурація

Налаштування керуються в `~/.claude-mem/settings.json` (автоматично створюється зі стандартними значеннями при першому запуску). Налаштуйте модель AI, порт воркера, каталог даних, рівень журналювання та параметри впровадження контексту.

Дивіться **[Посібник з конфігурації](https://docs.claude-mem.ai/configuration)** для всіх доступних налаштувань та прикладів.

---

## Розробка

Дивіться **[Посібник з розробки](https://docs.claude-mem.ai/development)** для інструкцій зі збірки, тестування та робочого процесу внеску.

---

## Усунення несправностей

Якщо виникають проблеми, опишіть проблему Claude, і навичка troubleshoot автоматично діагностує та надасть виправлення.

Дивіться **[Посібник з усунення несправностей](https://docs.claude-mem.ai/troubleshooting)** для поширених проблем та рішень.

---

## Звіти про помилки

Створюйте вичерпні звіти про помилки за допомогою автоматизованого генератора:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Внесок

Вітаються внески! Будь ласка:

1. Створіть форк репозиторію
2. Створіть гілку функції
3. Внесіть зміни з тестами
4. Оновіть документацію
5. Надішліть Pull Request

Дивіться [Посібник з розробки](https://docs.claude-mem.ai/development) для робочого процесу внеску.

---

## License

This project is licensed under the **Apache License 2.0** (Apache-2.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

Apache-2.0 allows broad use, modification, distribution, and commercial use, subject to its terms.

**Ragtime note**: The ragtime/ directory is licensed under the **Apache License 2.0**. See [ragtime/LICENSE](ragtime/LICENSE) for details.

---


## Підтримка

- **Документація**: [docs/](docs/)
- **Проблеми**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Репозиторій**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Автор**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Створено за допомогою Claude Agent SDK** | **Працює на Claude Code** | **Зроблено з TypeScript**