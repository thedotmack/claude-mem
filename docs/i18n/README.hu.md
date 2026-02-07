🌐 Ez egy automatikus fordítás. Közösségi javítások szívesen fogadottak!

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

<h4 align="center">Tartós memória tömörítési rendszer a <a href="https://claude.com/claude-code" target="_blank">Claude Code</a> számára.</h4>

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
  <a href="#gyors-kezdés">Gyors kezdés</a> •
  <a href="#hogyan-működik">Hogyan működik</a> •
  <a href="#keresési-eszközök">Keresési eszközök</a> •
  <a href="#dokumentáció">Dokumentáció</a> •
  <a href="#konfiguráció">Konfiguráció</a> •
  <a href="#hibaelhárítás">Hibaelhárítás</a> •
  <a href="#licenc">Licenc</a>
</p>

<p align="center">
  A Claude-Mem zökkenőmentesen megőrzi a kontextust munkamenetek között azáltal, hogy automatikusan rögzíti az eszközhasználati megfigyeléseket, szemantikus összefoglalókat generál, és elérhetővé teszi azokat a jövőbeli munkamenetekben. Ez lehetővé teszi Claude számára, hogy fenntartsa a projektekkel kapcsolatos tudás folytonosságát még a munkamenetek befejezése vagy újracsatlakozása után is.
</p>

---

## Gyors kezdés

Indítson el egy új Claude Code munkamenetet a terminálban, és írja be a következő parancsokat:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Indítsa újra a Claude Code-ot. A korábbi munkamenetek kontextusa automatikusan megjelenik az új munkamenetekben.

**Főbb jellemzők:**

- 🧠 **Tartós memória** - A kontextus túléli a munkameneteket
- 📊 **Progresszív felfedés** - Többrétegű memória-visszakeresés token költség láthatósággal
- 🔍 **Skill-alapú keresés** - Lekérdezheti projekt előzményeit a mem-search skill segítségével
- 🖥️ **Webes megjelenítő felület** - Valós idejű memória stream a http://localhost:37777 címen
- 💻 **Claude Desktop Skill** - Memória keresése Claude Desktop beszélgetésekből
- 🔒 **Adatvédelmi kontroll** - Használja a `<private>` címkéket az érzékeny tartalom kizárásához
- ⚙️ **Kontextus konfiguráció** - Finomhangolt kontroll afelett, hogy milyen kontextus kerül beillesztésre
- 🤖 **Automatikus működés** - Nincs szükség manuális beavatkozásra
- 🔗 **Hivatkozások** - Hivatkozás múltbeli megfigyelésekre ID-kkal (hozzáférés: http://localhost:37777/api/observation/{id} vagy mindegyik megtekintése a webes felületen a http://localhost:37777 címen)
- 🧪 **Béta csatorna** - Kísérleti funkciók, mint az Endless Mode kipróbálása verziócserével

---

## Dokumentáció

📚 **[Teljes dokumentáció megtekintése](https://docs.claude-mem.ai/)** - Böngészés a hivatalos weboldalon

### Első lépések

- **[Telepítési útmutató](https://docs.claude-mem.ai/installation)** - Gyors indítás és haladó telepítés
- **[Használati útmutató](https://docs.claude-mem.ai/usage/getting-started)** - Hogyan működik automatikusan a Claude-Mem
- **[Keresési eszközök](https://docs.claude-mem.ai/usage/search-tools)** - Projekt előzmények lekérdezése természetes nyelvvel
- **[Béta funkciók](https://docs.claude-mem.ai/beta-features)** - Kísérleti funkciók, mint az Endless Mode kipróbálása

### Bevált gyakorlatok

- **[Kontextus tervezés](https://docs.claude-mem.ai/context-engineering)** - AI ügynök kontextus optimalizálási elvek
- **[Progresszív felfedés](https://docs.claude-mem.ai/progressive-disclosure)** - A Claude-Mem kontextus előkészítési stratégiájának filozófiája

### Architektúra

- **[Áttekintés](https://docs.claude-mem.ai/architecture/overview)** - Rendszerkomponensek és adatfolyam
- **[Architektúra fejlődés](https://docs.claude-mem.ai/architecture-evolution)** - Az út a v3-tól a v5-ig
- **[Hooks architektúra](https://docs.claude-mem.ai/hooks-architecture)** - Hogyan használja a Claude-Mem az életciklus hookokat
- **[Hooks referencia](https://docs.claude-mem.ai/architecture/hooks)** - 7 hook szkript magyarázata
- **[Worker szolgáltatás](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API és Bun kezelés
- **[Adatbázis](https://docs.claude-mem.ai/architecture/database)** - SQLite séma és FTS5 keresés
- **[Keresési architektúra](https://docs.claude-mem.ai/architecture/search-architecture)** - Hibrid keresés Chroma vektor adatbázissal

### Konfiguráció és fejlesztés

- **[Konfiguráció](https://docs.claude-mem.ai/configuration)** - Környezeti változók és beállítások
- **[Fejlesztés](https://docs.claude-mem.ai/development)** - Építés, tesztelés, hozzájárulás
- **[Hibaelhárítás](https://docs.claude-mem.ai/troubleshooting)** - Gyakori problémák és megoldások

---

## Hogyan működik

**Fő komponensek:**

1. **5 életciklus hook** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook szkript)
2. **Intelligens telepítés** - Gyorsítótárazott függőség ellenőrző (pre-hook szkript, nem életciklus hook)
3. **Worker szolgáltatás** - HTTP API a 37777-es porton webes megjelenítő felülettel és 10 keresési végponttal, Bun által kezelve
4. **SQLite adatbázis** - Munkamenetek, megfigyelések, összefoglalók tárolása
5. **mem-search Skill** - Természetes nyelvi lekérdezések progresszív felfedéssel
6. **Chroma vektor adatbázis** - Hibrid szemantikus + kulcsszó keresés intelligens kontextus visszakereséshez

További részletekért lásd az [Architektúra áttekintést](https://docs.claude-mem.ai/architecture/overview).

---

## mem-search Skill

A Claude-Mem intelligens keresést biztosít a mem-search skillen keresztül, amely automatikusan aktiválódik, amikor múltbeli munkáról kérdez:

**Hogyan működik:**
- Csak kérdezzen természetesen: *"Mit csináltunk az előző munkamenetben?"* vagy *"Javítottuk már ezt a hibát korábban?"*
- Claude automatikusan meghívja a mem-search skillet a releváns kontextus megtalálásához

**Elérhető keresési műveletek:**

1. **Megfigyelések keresése** - Teljes szöveges keresés a megfigyelésekben
2. **Munkamenetek keresése** - Teljes szöveges keresés munkamenet összefoglalókban
3. **Promptok keresése** - Nyers felhasználói kérések keresése
4. **Koncepció szerint** - Keresés koncepció címkék alapján (discovery, problem-solution, pattern, stb.)
5. **Fájl szerint** - Adott fájlokra hivatkozó megfigyelések keresése
6. **Típus szerint** - Keresés típus alapján (decision, bugfix, feature, refactor, discovery, change)
7. **Legutóbbi kontextus** - Legutóbbi munkamenet kontextus lekérése egy projekthez
8. **Idővonal** - Egységes idővonal kontextus lekérése egy adott időpont körül
9. **Idővonal lekérdezéssel** - Megfigyelések keresése és idővonal kontextus lekérése a legjobb találat körül
10. **API segítség** - Keresési API dokumentáció lekérése

**Példa természetes nyelvi lekérdezésekre:**

```
"Milyen hibákat javítottunk az előző munkamenetben?"
"Hogyan implementáltuk az autentikációt?"
"Milyen változtatások történtek a worker-service.ts fájlban?"
"Mutasd a legutóbbi munkát ezen a projekten"
"Mi történt, amikor hozzáadtuk a megjelenítő felületet?"
```

Részletes példákért lásd a [Keresési eszközök útmutatót](https://docs.claude-mem.ai/usage/search-tools).

---

## Béta funkciók

A Claude-Mem **béta csatornát** kínál kísérleti funkciókkal, mint az **Endless Mode** (biomimetikus memória architektúra hosszabb munkamenetekhez). Váltson a stabil és béta verziók között a webes megjelenítő felületről a http://localhost:37777 → Settings címen.

További részletekért az Endless Mode-ról és annak kipróbálásáról lásd a **[Béta funkciók dokumentációt](https://docs.claude-mem.ai/beta-features)**.

---

## Rendszerkövetelmények

- **Node.js**: 18.0.0 vagy újabb
- **Claude Code**: Legújabb verzió plugin támogatással
- **Bun**: JavaScript futtatókörnyezet és folyamatkezelő (automatikusan települ, ha hiányzik)
- **uv**: Python csomagkezelő vektor kereséshez (automatikusan települ, ha hiányzik)
- **SQLite 3**: Tartós tároláshoz (mellékelve)

---

## Konfiguráció

A beállítások a `~/.claude-mem/settings.json` fájlban kezelhetők (automatikusan létrejön alapértelmezett értékekkel az első futtatáskor). Konfigurálható az AI modell, worker port, adatkönyvtár, naplózási szint és kontextus beillesztési beállítások.

Az összes elérhető beállításért és példákért lásd a **[Konfigurációs útmutatót](https://docs.claude-mem.ai/configuration)**.

---

## Fejlesztés

Az építési utasításokért, tesztelésért és hozzájárulási munkafolyamatért lásd a **[Fejlesztési útmutatót](https://docs.claude-mem.ai/development)**.

---

## Hibaelhárítás

Problémák esetén írja le a problémát Claude-nak, és a troubleshoot skill automatikusan diagnosztizálja és javítási megoldásokat kínál.

Gyakori problémákért és megoldásokért lásd a **[Hibaelhárítási útmutatót](https://docs.claude-mem.ai/troubleshooting)**.

---

## Hibajelentések

Átfogó hibajelentések készítése az automatikus generátorral:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Hozzájárulás

A hozzájárulásokat szívesen fogadjuk! Kérjük:

1. Fork-olja a tárolót
2. Hozzon létre egy feature branchet
3. Végezze el változtatásait tesztekkel
4. Frissítse a dokumentációt
5. Nyújtson be egy Pull Requestet

A hozzájárulási munkafolyamatért lásd a [Fejlesztési útmutatót](https://docs.claude-mem.ai/development).

---

## Licenc

Ez a projekt a **GNU Affero General Public License v3.0** (AGPL-3.0) alatt licencelt.

Copyright (C) 2025 Alex Newman (@thedotmack). Minden jog fenntartva.

A teljes részletekért lásd a [LICENSE](LICENSE) fájlt.

**Mit jelent ez:**

- Szabadon használhatja, módosíthatja és terjesztheti ezt a szoftvert
- Ha módosítja és hálózati szerveren telepíti, elérhetővé kell tennie a forráskódot
- A származékos munkáknak szintén AGPL-3.0 alatt kell licencelve lenniük
- Ehhez a szoftverhez NINCS GARANCIA

**Megjegyzés a Ragtime-ról**: A `ragtime/` könyvtár külön licencelt a **PolyForm Noncommercial License 1.0.0** alatt. Részletekért lásd a [ragtime/LICENSE](ragtime/LICENSE) fájlt.

---

## Támogatás

- **Dokumentáció**: [docs/](docs/)
- **Hibák**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Tároló**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Szerző**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Claude Agent SDK-val építve** | **Claude Code által hajtva** | **TypeScript-tel készítve**