🌐 Ito ay isang awtomatikong pagsasalin. Malugod na tinatanggap ang mga pagwawasto mula sa komunidad!

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
  <a href="README.fr.md">🇫🇷 Français</a> •
  <a href="README.he.md">🇮🇱 עברית</a> •
  <a href="README.ar.md">🇸🇦 العربية</a> •
  <a href="README.ru.md">🇷🇺 Русский</a> •
  <a href="README.pl.md">🇵🇱 Polski</a> •
  <a href="README.cs.md">🇨🇿 Čeština</a> •
  <a href="README.nl.md">🇳🇱 Nederlands</a> •
  <a href="README.tr.md">🇹🇷 Türkçe</a> •
  <a href="README.uk.md">🇺🇦 Українська</a> •
  <a href="README.vi.md">🇻🇳 Tiếng Việt</a> •
  <a href="README.tl.md">🇵🇭 Tagalog</a> •
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

<h4 align="center">Sistema ng kompresyon ng persistent memory na ginawa para sa <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#mabilis-na-pagsisimula">Mabilis na Pagsisimula</a> •
  <a href="#paano-ito-gumagana">Paano Ito Gumagana</a> •
  <a href="#mga-search-tool-ng-mcp">Mga Search Tool</a> •
  <a href="#dokumentasyon">Dokumentasyon</a> •
  <a href="#konpigurasyon">Konpigurasyon</a> •
  <a href="#pag-troubleshoot">Pag-troubleshoot</a> •
  <a href="#lisensya">Lisensya</a>
</p>

<p align="center">
  Pinapanatili ng Claude-Mem ang konteksto sa pagitan ng mga session sa pamamagitan ng awtomatikong pagkuha ng mga obserbasyon sa paggamit ng mga tool, pagbuo ng mga semantikong buod, at paggawa nitong available sa mga susunod na session. Dahil dito, napapanatili ni Claude ang tuloy-tuloy na kaalaman tungkol sa mga proyekto kahit matapos o muling kumonekta ang mga session.
</p>

---

## Mabilis na Pagsisimula

Magsimula ng bagong Claude Code session sa terminal at ilagay ang mga sumusunod na command:

```
/plugin marketplace add thedotmack/claude-mem

/plugin install claude-mem
```

I-restart ang Claude Code. Awtomatikong lalabas sa mga bagong session ang konteksto mula sa mga nakaraang session.

**Mga Pangunahing Tampok:**

- 🧠 **Persistent Memory** - Nananatili ang konteksto sa pagitan ng mga session
- 📊 **Progressive Disclosure** - Layered na pagkuha ng memory na may visibility ng token cost
- 🔍 **Skill-Based Search** - I-query ang history ng proyekto gamit ang mem-search skill
- 🖥️ **Web Viewer UI** - Real-time memory stream sa http://localhost:37777
- 💻 **Claude Desktop Skill** - Maghanap sa memory mula sa Claude Desktop conversations
- 🔒 **Privacy Control** - Gamitin ang `<private>` tags para hindi ma-store ang sensitibong nilalaman
- ⚙️ **Context Configuration** - Mas pinong kontrol kung anong konteksto ang ini-inject
- 🤖 **Automatic Operation** - Walang kailangang manual na intervention
- 🔗 **Citations** - I-refer ang mga lumang obserbasyon gamit ang IDs (i-access sa http://localhost:37777/api/observation/{id} o tingnan lahat sa web viewer sa http://localhost:37777)
- 🧪 **Beta Channel** - Subukan ang mga experimental feature tulad ng Endless Mode sa pamamagitan ng version switching

---

## Dokumentasyon

📚 **[Tingnan ang Buong Dokumentasyon](https://docs.claude-mem.ai/)** - I-browse sa opisyal na website

### Pagsisimula

- **[Gabay sa Pag-install](https://docs.claude-mem.ai/installation)** - Mabilis na pagsisimula at advanced installation
- **[Gabay sa Paggamit](https://docs.claude-mem.ai/usage/getting-started)** - Paano awtomatikong gumagana ang Claude-Mem
- **[Mga Search Tool](https://docs.claude-mem.ai/usage/search-tools)** - I-query ang history ng proyekto gamit ang natural language
- **[Mga Beta Feature](https://docs.claude-mem.ai/beta-features)** - Subukan ang mga experimental feature tulad ng Endless Mode

### Best Practices

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - Mga prinsipyo ng context optimization para sa AI agents
- **[Progressive Disclosure](https://docs.claude-mem.ai/progressive-disclosure)** - Pilosopiya sa likod ng context priming strategy ng Claude-Mem

### Arkitektura

- **[Overview](https://docs.claude-mem.ai/architecture/overview)** - Mga bahagi ng sistema at daloy ng data
- **[Architecture Evolution](https://docs.claude-mem.ai/architecture-evolution)** - Ang paglalakbay mula v3 hanggang v5
- **[Hooks Architecture](https://docs.claude-mem.ai/hooks-architecture)** - Paano gumagamit ang Claude-Mem ng lifecycle hooks
- **[Hooks Reference](https://docs.claude-mem.ai/architecture/hooks)** - 7 hook scripts, ipinaliwanag
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API at Bun management
- **[Database](https://docs.claude-mem.ai/architecture/database)** - SQLite schema at FTS5 search
- **[Search Architecture](https://docs.claude-mem.ai/architecture/search-architecture)** - Hybrid search gamit ang Chroma vector database

### Konpigurasyon at Pagbuo

- **[Konpigurasyon](https://docs.claude-mem.ai/configuration)** - Environment variables at settings
- **[Pagbuo](https://docs.claude-mem.ai/development)** - Build, test, at contribution workflow
- **[Pag-troubleshoot](https://docs.claude-mem.ai/troubleshooting)** - Karaniwang isyu at solusyon

---

## Paano Ito Gumagana

**Mga Pangunahing Bahagi:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook scripts)
2. **Smart Install** - Cached dependency checker (pre-hook script, hindi lifecycle hook)
3. **Worker Service** - HTTP API sa port 37777 na may web viewer UI at 10 search endpoints, pinamamahalaan ng Bun
4. **SQLite Database** - Nag-iimbak ng sessions, observations, summaries
5. **mem-search Skill** - Natural language queries na may progressive disclosure
6. **Chroma Vector Database** - Hybrid semantic + keyword search para sa matalinong pagkuha ng konteksto

Tingnan ang [Architecture Overview](https://docs.claude-mem.ai/architecture/overview) para sa detalye.

---

## Mga Search Tool ng MCP

Nagbibigay ang Claude-Mem ng intelligent memory search sa pamamagitan ng **5 MCP tools** na sumusunod sa token-efficient na **3-layer workflow pattern**:

**Ang 3-Layer Workflow:**

1. **`search`** - Kumuha ng compact index na may IDs (~50-100 tokens/result)
2. **`timeline`** - Kumuha ng chronological context sa paligid ng mga interesting na result
3. **`get_observations`** - Kunin ang full details PARA LANG sa na-filter na IDs (~500-1,000 tokens/result)

**Paano Ito Gumagana:**

- Gumagamit si Claude ng MCP tools para maghanap sa iyong memory
- Magsimula sa `search` para makakuha ng index ng results
- Gamitin ang `timeline` para makita ang nangyari sa paligid ng mga partikular na observation
- Gamitin ang `get_observations` para kunin ang full details ng mga relevant na IDs
- Gamitin ang `save_memory` para manual na mag-store ng importanteng impormasyon
- **~10x tipid sa tokens** dahil nagfi-filter muna bago kunin ang full details

**Available na MCP Tools:**

1. **`search`** - Hanapin ang memory index gamit ang full-text queries, may filters (type/date/project)
2. **`timeline`** - Kumuha ng chronological context sa paligid ng isang observation o query
3. **`get_observations`** - Kumuha ng full observation details gamit ang IDs (laging i-batch ang maraming IDs)
4. **`save_memory`** - Manual na mag-save ng memory/observation para sa semantic search
5. **`__IMPORTANT`** - Workflow documentation (laging visible kay Claude)

**Halimbawa ng Paggamit:**

```typescript
// Step 1: Search for index
search(query="authentication bug", type="bugfix", limit=10)

// Step 2: Review index, identify relevant IDs (e.g., #123, #456)

// Step 3: Fetch full details
get_observations(ids=[123, 456])

// Save important information manually
save_memory(text="API requires auth header X-API-Key", title="API Auth")
```

Tingnan ang [Search Tools Guide](https://docs.claude-mem.ai/usage/search-tools) para sa mas detalyadong mga halimbawa.

---

## Mga Beta Feature

May **beta channel** ang Claude-Mem na may mga experimental feature gaya ng **Endless Mode** (biomimetic memory architecture para sa mas mahahabang session). Magpalit sa pagitan ng stable at beta versions sa web viewer UI sa http://localhost:37777 → Settings.

Tingnan ang **[Dokumentasyon ng Mga Beta Feature](https://docs.claude-mem.ai/beta-features)** para sa detalye ng Endless Mode at kung paano ito subukan.

---

## Mga Pangangailangan ng Sistema

- **Node.js**: 18.0.0 o mas mataas
- **Claude Code**: Pinakabagong bersyon na may plugin support
- **Bun**: JavaScript runtime at process manager (auto-installed kung wala)
- **uv**: Python package manager para sa vector search (auto-installed kung wala)
- **SQLite 3**: Para sa persistent storage (kasama)

---

### Mga Tala sa Windows Setup

Kung makakita ka ng error gaya ng:

```powershell
npm : The term 'npm' is not recognized as the name of a cmdlet
```

Siguraduhing naka-install ang Node.js at npm at nakadagdag sa PATH. I-download ang pinakabagong Node.js installer mula sa https://nodejs.org at i-restart ang terminal matapos mag-install.

---

## Konpigurasyon

Pinamamahalaan ang settings sa `~/.claude-mem/settings.json` (auto-created na may defaults sa unang run). I-configure ang AI model, worker port, data directory, log level, at context injection settings.

Tingnan ang **[Gabay sa Konpigurasyon](https://docs.claude-mem.ai/configuration)** para sa lahat ng available na settings at mga halimbawa.

---

## Pagbuo

Tingnan ang **[Gabay nang pagbuo](https://docs.claude-mem.ai/development)** para sa pag build instructions, testing, at contribution workflow.

---

## Pag-troubleshoot

Kung may issue, ilarawan ang problema kay Claude at awtomatikong magdi-diagnose at magbibigay ng mga ayos ang troubleshoot skill.

Tingnan ang **[Troubleshooting Guide](https://docs.claude-mem.ai/troubleshooting)** para sa mga karaniwang isyu at solusyon.

---

## Bug Reports

Gumawa ng kumpletong bug reports gamit ang automated generator:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Pag-aambag

Malugod na tinatanggap ang mga kontribusyon! Pakisunod:

1. I-fork ang repository
2. Gumawa ng feature branch
3. Gawin ang mga pagbabago kasama ang tests
4. I-update ang dokumentasyon
5. Mag-submit ng Pull Request

Tingnan ang [Gabay nang pagbuo](https://docs.claude-mem.ai/development) para sa contribution workflow.

---

## Lisensya

Ang proyektong ito ay licensed sa ilalim ng **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

Tingnan ang [LICENSE](LICENSE) file para sa buong detalye.

**Ano ang ibig sabihin nito:**

- Maaari mong gamitin, baguhin, at ipamahagi ang software na ito nang libre
- Kung babaguhin mo at i-deploy sa isang network server, kailangan mong gawing available ang iyong source code
- Dapat ding naka-license sa AGPL-3.0 ang mga derivative works
- WALANG WARRANTY para sa software na ito

**Tala tungkol sa Ragtime**: Ang `ragtime/` directory ay may hiwalay na lisensya sa ilalim ng **PolyForm Noncommercial License 1.0.0**. Tingnan ang [ragtime/LICENSE](ragtime/LICENSE) para sa detalye.

---

## Suporta

- **Dokumentasyon**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Author**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Built with Claude Agent SDK** | **Powered by Claude Code** | **Made with TypeScript**
