🌐 Bu otomatik bir çevirisidir. Topluluk düzeltmeleri memnuniyetle karşılanır!

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

<h4 align="center"><a href="https://claude.com/claude-code" target="_blank">Claude Code</a> için geliştirilmiş kalıcı bellek sıkıştırma sistemi.</h4>

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
  <a href="#hızlı-başlangıç">Hızlı Başlangıç</a> •
  <a href="#nasıl-çalışır">Nasıl Çalışır</a> •
  <a href="#mcp-arama-araçları">Arama Araçları</a> •
  <a href="#dokümantasyon">Dokümantasyon</a> •
  <a href="#yapılandırma">Yapılandırma</a> •
  <a href="#sorun-giderme">Sorun Giderme</a> •
  <a href="#lisans">Lisans</a>
</p>

<p align="center">
  Claude-Mem, araç kullanım gözlemlerini otomatik olarak yakalayarak, anlamsal özetler oluşturarak ve bunları gelecekteki oturumlarda kullanılabilir hale getirerek bağlamı oturumlar arası sorunsuzca korur. Bu, Claude'un oturumlar sona erse veya yeniden bağlansa bile projeler hakkındaki bilgi sürekliliğini korumasını sağlar.
</p>

---

## Hızlı Başlangıç

Terminal üzerinden yeni bir Claude Code oturumu başlatın ve aşağıdaki komutları girin:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Claude Code'u yeniden başlatın. Önceki oturumlardaki bağlam otomatik olarak yeni oturumlarda görünecektir.

**Temel Özellikler:**

- 🧠 **Kalıcı Bellek** - Bağlam oturumlar arası hayatta kalır
- 📊 **Aşamalı Açıklama** - Token maliyeti görünürlüğü ile katmanlı bellek erişimi
- 🔍 **Beceri Tabanlı Arama** - mem-search becerisi ile proje geçmişinizi sorgulayın
- 🖥️ **Web Görüntüleyici Arayüzü** - http://localhost:37777 adresinde gerçek zamanlı bellek akışı
- 💻 **Claude Desktop Becerisi** - Claude Desktop konuşmalarından bellek araması yapın
- 🔒 **Gizlilik Kontrolü** - Hassas içeriği depolamadan hariç tutmak için `<private>` etiketlerini kullanın
- ⚙️ **Bağlam Yapılandırması** - Hangi bağlamın enjekte edileceği üzerinde detaylı kontrol
- 🤖 **Otomatik Çalışma** - Manuel müdahale gerektirmez
- 🔗 **Alıntılar** - ID'lerle geçmiş gözlemlere referans verin (http://localhost:37777/api/observation/{id} üzerinden erişin veya http://localhost:37777 adresindeki web görüntüleyicide tümünü görüntüleyin)
- 🧪 **Beta Kanalı** - Sürüm değiştirme yoluyla Endless Mode gibi deneysel özellikleri deneyin

---

## Dokümantasyon

📚 **[Tam Dokümantasyonu Görüntüle](https://docs.claude-mem.ai/)** - Resmi web sitesinde göz atın

### Başlarken

- **[Kurulum Kılavuzu](https://docs.claude-mem.ai/installation)** - Hızlı başlangıç ve gelişmiş kurulum
- **[Kullanım Kılavuzu](https://docs.claude-mem.ai/usage/getting-started)** - Claude-Mem otomatik olarak nasıl çalışır
- **[Arama Araçları](https://docs.claude-mem.ai/usage/search-tools)** - Doğal dil ile proje geçmişinizi sorgulayın
- **[Beta Özellikleri](https://docs.claude-mem.ai/beta-features)** - Endless Mode gibi deneysel özellikleri deneyin

### En İyi Uygulamalar

- **[Bağlam Mühendisliği](https://docs.claude-mem.ai/context-engineering)** - AI ajan bağlam optimizasyon ilkeleri
- **[Aşamalı Açıklama](https://docs.claude-mem.ai/progressive-disclosure)** - Claude-Mem'in bağlam hazırlama stratejisinin ardındaki felsefe

### Mimari

- **[Genel Bakış](https://docs.claude-mem.ai/architecture/overview)** - Sistem bileşenleri ve veri akışı
- **[Mimari Evrimi](https://docs.claude-mem.ai/architecture-evolution)** - v3'ten v5'e yolculuk
- **[Hooks Mimarisi](https://docs.claude-mem.ai/hooks-architecture)** - Claude-Mem yaşam döngüsü hook'larını nasıl kullanır
- **[Hooks Referansı](https://docs.claude-mem.ai/architecture/hooks)** - 7 hook betiği açıklandı
- **[Worker Servisi](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API ve Bun yönetimi
- **[Veritabanı](https://docs.claude-mem.ai/architecture/database)** - SQLite şeması ve FTS5 arama
- **[Arama Mimarisi](https://docs.claude-mem.ai/architecture/search-architecture)** - Chroma vektör veritabanı ile hibrit arama

### Yapılandırma ve Geliştirme

- **[Yapılandırma](https://docs.claude-mem.ai/configuration)** - Ortam değişkenleri ve ayarlar
- **[Geliştirme](https://docs.claude-mem.ai/development)** - Derleme, test etme, katkıda bulunma
- **[Sorun Giderme](https://docs.claude-mem.ai/troubleshooting)** - Yaygın sorunlar ve çözümler

---

## Nasıl Çalışır

**Temel Bileşenler:**

1. **5 Yaşam Döngüsü Hook'u** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook betiği)
2. **Akıllı Kurulum** - Önbelleğe alınmış bağımlılık kontrolcüsü (ön-hook betiği, yaşam döngüsü hook'u değil)
3. **Worker Servisi** - Web görüntüleyici arayüzü ve 10 arama uç noktası ile 37777 portunda HTTP API, Bun tarafından yönetilir
4. **SQLite Veritabanı** - Oturumları, gözlemleri, özetleri saklar
5. **mem-search Becerisi** - Aşamalı açıklama ile doğal dil sorguları
6. **Chroma Vektör Veritabanı** - Akıllı bağlam erişimi için hibrit anlamsal + anahtar kelime arama

Detaylar için [Mimari Genel Bakış](https://docs.claude-mem.ai/architecture/overview) bölümüne bakın.

---

## mem-search Becerisi

Claude-Mem, geçmiş çalışmalarınız hakkında sorduğunuzda otomatik olarak devreye giren mem-search becerisi aracılığıyla akıllı arama sağlar:

**Nasıl Çalışır:**
- Sadece doğal bir şekilde sorun: *"Geçen oturumda ne yaptık?"* veya *"Bu hatayı daha önce düzelttik mi?"*
- Claude, ilgili bağlamı bulmak için otomatik olarak mem-search becerisini çağırır

**Mevcut Arama İşlemleri:**

1. **Search Observations** - Gözlemler arasında tam metin arama
2. **Search Sessions** - Oturum özetleri arasında tam metin arama
3. **Search Prompts** - Ham kullanıcı isteklerinde arama
4. **By Concept** - Kavram etiketlerine göre bul (discovery, problem-solution, pattern, vb.)
5. **By File** - Belirli dosyalara referans veren gözlemleri bul
6. **By Type** - Türe göre bul (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Bir proje için yakın zamanlı oturum bağlamını al
8. **Timeline** - Belirli bir zaman noktası etrafındaki birleşik bağlam zaman çizelgesini al
9. **Timeline by Query** - Gözlemleri ara ve en iyi eşleşme etrafındaki zaman çizelgesi bağlamını al
10. **API Help** - Arama API dokümantasyonunu al

**Örnek Doğal Dil Sorguları:**

```
"Geçen oturumda hangi hataları düzelttik?"
"Kimlik doğrulamayı nasıl uyguladık?"
"worker-service.ts dosyasında hangi değişiklikler yapıldı?"
"Bu projedeki son çalışmaları göster"
"Görüntüleyici arayüzünü eklediğimizde ne oluyordu?"
```

Detaylı örnekler için [Arama Araçları Kılavuzu](https://docs.claude-mem.ai/usage/search-tools) bölümüne bakın.

---

## Beta Özellikleri

Claude-Mem, **Endless Mode** (genişletilmiş oturumlar için biyomimetik bellek mimarisi) gibi deneysel özellikler içeren bir **beta kanalı** sunar. http://localhost:37777 → Settings adresindeki web görüntüleyici arayüzünden kararlı ve beta sürümleri arasında geçiş yapın.

Endless Mode hakkında detaylar ve nasıl deneyeceğiniz için **[Beta Özellikleri Dokümantasyonu](https://docs.claude-mem.ai/beta-features)** bölümüne bakın.

---

## Sistem Gereksinimleri

- **Node.js**: 18.0.0 veya üzeri
- **Claude Code**: Plugin desteği olan en son sürüm
- **Bun**: JavaScript çalışma zamanı ve işlem yöneticisi (eksikse otomatik kurulur)
- **uv**: Vektör arama için Python paket yöneticisi (eksikse otomatik kurulur)
- **SQLite 3**: Kalıcı depolama için (dahildir)

---

## Yapılandırma

Ayarlar `~/.claude-mem/settings.json` dosyasında yönetilir (ilk çalıştırmada varsayılanlarla otomatik oluşturulur). AI modelini, worker portunu, veri dizinini, log seviyesini ve bağlam enjeksiyon ayarlarını yapılandırın.

Tüm mevcut ayarlar ve örnekler için **[Yapılandırma Kılavuzu](https://docs.claude-mem.ai/configuration)** bölümüne bakın.

---

## Geliştirme

Derleme talimatları, test etme ve katkı iş akışı için **[Geliştirme Kılavuzu](https://docs.claude-mem.ai/development)** bölümüne bakın.

---

## Sorun Giderme

Sorunlarla karşılaşırsanız, sorunu Claude'a açıklayın ve troubleshoot becerisi otomatik olarak teşhis edip düzeltmeleri sağlayacaktır.

Yaygın sorunlar ve çözümler için **[Sorun Giderme Kılavuzu](https://docs.claude-mem.ai/troubleshooting)** bölümüne bakın.

---

## Hata Raporları

Otomatik oluşturucu ile kapsamlı hata raporları oluşturun:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Katkıda Bulunma

Katkılar memnuniyetle karşılanır! Lütfen:

1. Depoyu fork edin
2. Bir özellik dalı oluşturun
3. Testlerle değişikliklerinizi yapın
4. Dokümantasyonu güncelleyin
5. Pull Request gönderin

Katkı iş akışı için [Geliştirme Kılavuzu](https://docs.claude-mem.ai/development) bölümüne bakın.

---

## Lisans

Bu proje **GNU Affero General Public License v3.0** (AGPL-3.0) altında lisanslanmıştır.

Telif Hakkı (C) 2025 Alex Newman (@thedotmack). Tüm hakları saklıdır.

Tam detaylar için [LICENSE](LICENSE) dosyasına bakın.

**Bu Ne Anlama Gelir:**

- Bu yazılımı özgürce kullanabilir, değiştirebilir ve dağıtabilirsiniz
- Değiştirip bir ağ sunucusunda dağıtırsanız, kaynak kodunuzu kullanılabilir hale getirmelisiniz
- Türev çalışmalar da AGPL-3.0 altında lisanslanmalıdır
- Bu yazılım için HİÇBİR GARANTİ yoktur

**Ragtime Hakkında Not**: `ragtime/` dizini ayrı olarak **PolyForm Noncommercial License 1.0.0** altında lisanslanmıştır. Detaylar için [ragtime/LICENSE](ragtime/LICENSE) dosyasına bakın.

---

## Destek

- **Dokümantasyon**: [docs/](docs/)
- **Sorunlar**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Depo**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Yazar**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Claude Agent SDK ile geliştirilmiştir** | **Claude Code ile desteklenmektedir** | **TypeScript ile yapılmıştır**