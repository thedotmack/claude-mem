🌐 Tämä on automaattinen käännös. Yhteisön korjaukset ovat tervetulleita!

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

<h4 align="center">Pysyvä muistinpakkaamisjärjestelmä, joka on rakennettu <a href="https://claude.com/claude-code" target="_blank">Claude Code</a> -ympäristöön.</h4>

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
  <a href="#pikaopas">Pikaopas</a> •
  <a href="#miten-se-toimii">Miten se toimii</a> •
  <a href="#hakutyökalut">Hakutyökalut</a> •
  <a href="#dokumentaatio">Dokumentaatio</a> •
  <a href="#asetukset">Asetukset</a> •
  <a href="#vianmääritys">Vianmääritys</a> •
  <a href="#lisenssi">Lisenssi</a>
</p>

<p align="center">
  Claude-Mem säilyttää kontekstin saumattomasti istuntojen välillä tallentamalla automaattisesti työkalujen käyttöhavaintoja, luomalla semanttisia yhteenvetoja ja asettamalla ne tulevien istuntojen saataville. Tämä mahdollistaa Clauden säilyttää tiedon jatkuvuuden projekteista senkin jälkeen, kun istunnot päättyvät tai yhteys palautuu.
</p>

---

## Pikaopas

Aloita uusi Claude Code -istunto terminaalissa ja syötä seuraavat komennot:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Käynnistä Claude Code uudelleen. Aiempien istuntojen konteksti ilmestyy automaattisesti uusiin istuntoihin.

**Keskeiset ominaisuudet:**

- 🧠 **Pysyvä muisti** - Konteksti säilyy istuntojen välillä
- 📊 **Asteittainen paljastaminen** - Kerrostettu muistin haku tokenikustannusten näkyvyydellä
- 🔍 **Taitopohjainen haku** - Kysy projektihistoriaasi mem-search-taidolla
- 🖥️ **Web-katselukäyttöliittymä** - Reaaliaikainen muistivirta osoitteessa http://localhost:37777
- 💻 **Claude Desktop -taito** - Hae muistista Claude Desktop -keskusteluissa
- 🔒 **Yksityisyyden hallinta** - Käytä `<private>`-tageja arkaluonteisen sisällön poissulkemiseen tallennuksesta
- ⚙️ **Kontekstin määrittely** - Tarkka hallinta siitä, mikä konteksti injektoidaan
- 🤖 **Automaattinen toiminta** - Ei vaadi manuaalista puuttumista
- 🔗 **Viittaukset** - Viittaa aiempiin havaintoihin ID:llä (käytettävissä osoitteessa http://localhost:37777/api/observation/{id} tai näytä kaikki web-katselussa osoitteessa http://localhost:37777)
- 🧪 **Beta-kanava** - Kokeile kokeellisia ominaisuuksia kuten Endless Mode versionvaihdolla

---

## Dokumentaatio

📚 **[Näytä täydellinen dokumentaatio](docs/)** - Selaa markdown-dokumentteja GitHubissa

### Aloitus

- **[Asennusopas](https://docs.claude-mem.ai/installation)** - Pikaopas ja edistynyt asennus
- **[Käyttöopas](https://docs.claude-mem.ai/usage/getting-started)** - Miten Claude-Mem toimii automaattisesti
- **[Hakutyökalut](https://docs.claude-mem.ai/usage/search-tools)** - Kysy projektihistoriaasi luonnollisella kielellä
- **[Beta-ominaisuudet](https://docs.claude-mem.ai/beta-features)** - Kokeile kokeellisia ominaisuuksia kuten Endless Mode

### Parhaat käytännöt

- **[Kontekstisuunnittelu](https://docs.claude-mem.ai/context-engineering)** - AI-agentin kontekstin optimointiperiaatteet
- **[Asteittainen paljastaminen](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofia Claude-Mem-kontekstin valmistelustrategian takana

### Arkkitehtuuri

- **[Yleiskatsaus](https://docs.claude-mem.ai/architecture/overview)** - Järjestelmän komponentit ja datavirta
- **[Arkkitehtuurin kehitys](https://docs.claude-mem.ai/architecture-evolution)** - Matka versiosta v3 versioon v5
- **[Koukku-arkkitehtuuri](https://docs.claude-mem.ai/hooks-architecture)** - Miten Claude-Mem käyttää elinkaarikkoukkuja
- **[Koukku-viittaus](https://docs.claude-mem.ai/architecture/hooks)** - 7 koukku-skriptiä selitettynä
- **[Worker-palvelu](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API ja Bun-hallinta
- **[Tietokanta](https://docs.claude-mem.ai/architecture/database)** - SQLite-skeema ja FTS5-haku
- **[Hakuarkkitehtuuri](https://docs.claude-mem.ai/architecture/search-architecture)** - Hybridihaku Chroma-vektoritietokannalla

### Asetukset ja kehitys

- **[Asetukset](https://docs.claude-mem.ai/configuration)** - Ympäristömuuttujat ja asetukset
- **[Kehitys](https://docs.claude-mem.ai/development)** - Rakentaminen, testaus, osallistuminen
- **[Vianmääritys](https://docs.claude-mem.ai/troubleshooting)** - Yleiset ongelmat ja ratkaisut

---

## Miten se toimii

**Keskeiset komponentit:**

1. **5 elinkaarikoukua** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 koukku-skriptiä)
2. **Älykäs asennus** - Välimuistettu riippuvuuksien tarkistaja (esikoukku-skripti, ei elinkaarikkoukku)
3. **Worker-palvelu** - HTTP API portissa 37777 web-katselukäyttöliittymällä ja 10 hakupäätepisteellä, Bun-hallinnoimana
4. **SQLite-tietokanta** - Tallentaa istunnot, havainnot, yhteenvedot
5. **mem-search-taito** - Luonnollisen kielen kyselyt asteittaisella paljastamisella
6. **Chroma-vektoritietokanta** - Hybridi semanttinen + avainsanahaku älykkääseen kontekstin hakuun

Katso [Arkkitehtuurin yleiskatsaus](https://docs.claude-mem.ai/architecture/overview) yksityiskohdista.

---

## mem-search-taito

Claude-Mem tarjoaa älykkään haun mem-search-taidon kautta, joka käynnistyy automaattisesti kun kysyt aiemmasta työstä:

**Miten se toimii:**
- Kysy vain luonnollisesti: *"Mitä teimme viime istunnossa?"* tai *"Korjasimmeko tämän bugin aiemmin?"*
- Claude käynnistää automaattisesti mem-search-taidon löytääkseen relevantin kontekstin

**Saatavilla olevat hakutoiminnot:**

1. **Hae havaintoja** - Koko tekstin haku havainnoissa
2. **Hae istuntoja** - Koko tekstin haku istuntojen yhteenvedoissa
3. **Hae prompteja** - Hae raakoista käyttäjäpyynnöistä
4. **Konseptin mukaan** - Hae konseptitageilla (discovery, problem-solution, pattern, jne.)
5. **Tiedoston mukaan** - Hae tiettyihin tiedostoihin viittaavia havaintoja
6. **Tyypin mukaan** - Hae tyypillä (decision, bugfix, feature, refactor, discovery, change)
7. **Viimeaikainen konteksti** - Hae projektin viimeaikainen istuntokonteksti
8. **Aikajana** - Hae yhtenäinen aikajana kontekstista tietyn ajankohdan ympärillä
9. **Aikajana kyselyn mukaan** - Hae havaintoja ja saa aikalinjakonteksti parhaan osuman ympärillä
10. **API-ohje** - Hae haku-API:n dokumentaatio

**Esimerkkejä luonnollisen kielen kyselyistä:**

```
"Mitkä bugit korjasimme viime istunnossa?"
"Miten toteutimme autentikoinnin?"
"Mitä muutoksia tehtiin worker-service.ts:ään?"
"Näytä viimeaikainen työ tässä projektissa"
"Mitä tapahtui kun lisäsimme katselukäyttöliittymän?"
```

Katso [Hakutyökalujen opas](https://docs.claude-mem.ai/usage/search-tools) yksityiskohtaisia esimerkkejä varten.

---

## Beta-ominaisuudet

Claude-Mem tarjoaa **beta-kanavan** kokeellisilla ominaisuuksilla kuten **Endless Mode** (biomimeettinen muistiarkkitehtuuri pidennetyille istunnoille). Vaihda vakaan ja beta-version välillä web-katselukäyttöliittymästä osoitteessa http://localhost:37777 → Settings.

Katso **[Beta-ominaisuuksien dokumentaatio](https://docs.claude-mem.ai/beta-features)** yksityiskohdista Endless Moden ja sen kokeilemisen osalta.

---

## Järjestelmävaatimukset

- **Node.js**: 18.0.0 tai uudempi
- **Claude Code**: Uusin versio plugin-tuella
- **Bun**: JavaScript-ajoympäristö ja prosessinhallinta (asennetaan automaattisesti jos puuttuu)
- **uv**: Python-paketinhallinta vektorihakuun (asennetaan automaattisesti jos puuttuu)
- **SQLite 3**: Pysyvälle tallennukselle (sisältyy)

---

## Asetukset

Asetuksia hallitaan tiedostossa `~/.claude-mem/settings.json` (luodaan automaattisesti oletusarvoilla ensimmäisellä suorituskerralla). Määritä AI-malli, worker-portti, datahakemisto, lokitaso ja kontekstin injektointiasetukset.

Katso **[Asetusopas](https://docs.claude-mem.ai/configuration)** kaikista saatavilla olevista asetuksista ja esimerkeistä.

---

## Kehitys

Katso **[Kehitysopas](https://docs.claude-mem.ai/development)** rakennusohjeista, testauksesta ja osallistumisen työnkulusta.

---

## Vianmääritys

Jos kohtaat ongelmia, kuvaile ongelma Claudelle ja troubleshoot-taito diagnosoi automaattisesti ja tarjoaa korjauksia.

Katso **[Vianmääritysopas](https://docs.claude-mem.ai/troubleshooting)** yleisistä ongelmista ja ratkaisuista.

---

## Bugiraportit

Luo kattavia bugiraportteja automaattisella generaattorilla:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Osallistuminen

Osallistuminen on tervetullutta! Ole hyvä:

1. Haarukoi repositorio
2. Luo ominaisuushaara
3. Tee muutoksesi testeineen
4. Päivitä dokumentaatio
5. Lähetä Pull Request

Katso [Kehitysopas](https://docs.claude-mem.ai/development) osallistumisen työnkulusta.

---

## Lisenssi

Tämä projekti on lisensoitu **GNU Affero General Public License v3.0** (AGPL-3.0) -lisenssillä.

Copyright (C) 2025 Alex Newman (@thedotmack). Kaikki oikeudet pidätetään.

Katso [LICENSE](LICENSE)-tiedosto täydellisistä yksityiskohdista.

**Mitä tämä tarkoittaa:**

- Voit käyttää, muokata ja jakaa tätä ohjelmistoa vapaasti
- Jos muokkaat ja otat käyttöön verkkopalvelimella, sinun on asetettava lähdekoodisi saataville
- Johdannaisten teosten on myös oltava AGPL-3.0-lisensoituja
- Tälle ohjelmistolle EI OLE TAKUUTA

**Huomautus Ragtimesta**: `ragtime/`-hakemisto on erikseen lisensoitu **PolyForm Noncommercial License 1.0.0** -lisenssillä. Katso [ragtime/LICENSE](ragtime/LICENSE) yksityiskohdista.

---

## Tuki

- **Dokumentaatio**: [docs/](docs/)
- **Ongelmat**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repositorio**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Tekijä**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Rakennettu Claude Agent SDK:lla** | **Claude Coden voimalla** | **Tehty TypeScriptillä**