🌐 Bu otomatik bir çeviredir. Topluluk düzeltmeleri beklenmektedir!

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

<h4 align="center"><a href="https://claude.com/claude-code" target="_blank">Claude Code</a> için geliştirilmiş kalıcı hafıza sıkıştırma sistemi.</h4>

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
  <a href="#hızlı-başlangıç">Hızlı Başlangıç</a> •
  <a href="#nasıl-çalışır">Nasıl Çalışır</a> •
  <a href="#arama-araçları">Arama Araçları</a> •
  <a href="#dokümantasyon">Dokümantasyon</a> •
  <a href="#yapılandırma">Yapılandırma</a> •
  <a href="#sorun-giderme">Sorun Giderme</a> •
  <a href="#lisans">Lisans</a>
</p>

<p align="center">
  Claude-Mem, araç kullanım gözlemlerini otomatik olarak yakalayarak, anlamsal özetler oluşturarak ve bunları gelecek oturumlarda kullanılabilir hale getirerek oturumlar arası bağlamı sorunsuz bir şekilde korur. Bu, Claude'un oturumlar sona erdikten veya yeniden bağlandıktan sonra bile projeler hakkındaki bilgi sürekliliğini korumasını sağlar.
</p>

---

## Hızlı Başlangıç

Terminalde yeni bir Claude Code oturumu başlatın ve aşağıdaki komutları girin:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Claude Code'u yeniden başlatın. Önceki oturumlardaki bağlam otomatik olarak yeni oturumlarda görünecektir.

**Temel Özellikler:**

- 🧠 **Kalıcı Hafıza** - Bağlam oturumlar arasında korunur
- 📊 **Aşamalı Açığa Çıkarma** - Token maliyeti görünürlüğü ile katmanlı hafıza erişimi
- 🔍 **Beceri Tabanlı Arama** - mem-search becerisi ile proje geçmişinizi sorgulayın (~2,250 token tasarrufu)
- 🖥️ **Web Görüntüleyici Arayüzü** - http://localhost:37777 adresinde gerçek zamanlı hafıza akışı
- 🔒 **Gizlilik Kontrolü** - Hassas içeriği depolamadan hariç tutmak için `<private>` etiketlerini kullanın
- ⚙️ **Bağlam Yapılandırması** - Hangi bağlamın enjekte edileceği üzerinde ayrıntılı kontrol
- 🤖 **Otomatik İşleyiş** - Manuel müdahale gerektirmez
- 🔗 **Alıntılar** - `claude-mem://` URI'ları ile geçmiş kararlara referans verin
- 🧪 **Beta Kanalı** - Sürüm değiştirme ile Endless Mode gibi deneysel özellikleri deneyin

---

## Dokümantasyon

📚 **[Tam Dokümantasyonu Görüntüle](docs/)** - GitHub'da markdown dokümanlarına göz atın

💻 **Yerel Önizleme**: Mintlify dokümanlarını yerel olarak çalıştırın:

```bash
cd docs
npx mintlify dev
```

### Başlarken

- **[Kurulum Kılavuzu](https://docs.claude-mem.ai/installation)** - Hızlı başlangıç ve gelişmiş kurulum
- **[Kullanım Kılavuzu](https://docs.claude-mem.ai/usage/getting-started)** - Claude-Mem otomatik olarak nasıl çalışır
- **[Arama Araçları](https://docs.claude-mem.ai/usage/search-tools)** - Doğal dil ile proje geçmişinizi sorgulayın
- **[Beta Özellikleri](https://docs.claude-mem.ai/beta-features)** - Endless Mode gibi deneysel özellikleri deneyin

### En İyi Uygulamalar

- **[Bağlam Mühendisliği](https://docs.claude-mem.ai/context-engineering)** - AI ajan bağlam optimizasyon ilkeleri
- **[Aşamalı Açığa Çıkarma](https://docs.claude-mem.ai/progressive-disclosure)** - Claude-Mem'in bağlam hazırlama stratejisinin arkasındaki felsefe

### Mimari

- **[Genel Bakış](https://docs.claude-mem.ai/architecture/overview)** - Sistem bileşenleri ve veri akışı
- **[Mimari Evrimi](https://docs.claude-mem.ai/architecture-evolution)** - v3'ten v5'e yolculuk
- **[Hooks Mimarisi](https://docs.claude-mem.ai/hooks-architecture)** - Claude-Mem yaşam döngüsü hook'larını nasıl kullanır
- **[Hooks Referansı](https://docs.claude-mem.ai/architecture/hooks)** - 7 hook betiği açıklandı
- **[Worker Servisi](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API ve PM2 yönetimi
- **[Veritabanı](https://docs.claude-mem.ai/architecture/database)** - SQLite şeması ve FTS5 arama
- **[Arama Mimarisi](https://docs.claude-mem.ai/architecture/search-architecture)** - Chroma vektör veritabanı ile hibrit arama

### Yapılandırma ve Geliştirme

- **[Yapılandırma](https://docs.claude-mem.ai/configuration)** - Ortam değişkenleri ve ayarlar
- **[Geliştirme](https://docs.claude-mem.ai/development)** - Derleme, test etme, katkıda bulunma
- **[Sorun Giderme](https://docs.claude-mem.ai/troubleshooting)** - Yaygın sorunlar ve çözümler

---

## Nasıl Çalışır

```
┌─────────────────────────────────────────────────────────────┐
│ Oturum Başlangıcı → Son gözlemleri bağlam olarak enjekte et │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Kullanıcı İstemleri → Oturum oluştur, kullanıcı istemlerini│
│                        kaydet                                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Araç Yürütmeleri → Gözlemleri yakala (Read, Write, vb.)    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Worker İşlemleri → Claude Agent SDK ile öğrenimleri çıkar   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Oturum Sonu → Özet oluştur, bir sonraki oturum için hazır   │
└─────────────────────────────────────────────────────────────┘
```

**Temel Bileşenler:**

1. **5 Yaşam Döngüsü Hook'u** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook betiği)
2. **Akıllı Kurulum** - Önbellekli bağımlılık denetleyicisi (ön-hook betiği, yaşam döngüsü hook'u değil)
3. **Worker Servisi** - PM2 tarafından yönetilen, web görüntüleyici arayüzü ve 10 arama uç noktası ile 37777 portunda HTTP API
4. **SQLite Veritabanı** - FTS5 tam metin arama ile oturumları, gözlemleri, özetleri saklar
5. **mem-search Becerisi** - Aşamalı açığa çıkarma ile doğal dil sorguları (~2,250 token tasarrufu, MCP'ye kıyasla)
6. **Chroma Vektör Veritabanı** - Akıllı bağlam erişimi için hibrit anlamsal + anahtar kelime arama

Detaylar için [Mimari Genel Bakış](https://docs.claude-mem.ai/architecture/overview) sayfasına bakın.

---

## mem-search Becerisi

Claude-Mem, geçmiş çalışmalar hakkında sorduğunuzda otomatik olarak devreye giren mem-search becerisi aracılığıyla akıllı arama sağlar:

**Nasıl Çalışır:**
- Sadece doğal olarak sorun: *"Geçen oturumda ne yaptık?"* veya *"Bu hatayı daha önce düzelttik mi?"*
- Claude, ilgili bağlamı bulmak için otomatik olarak mem-search becerisini çağırır
- MCP yaklaşımına kıyasla oturum başına ~2,250 token tasarrufu

**Mevcut Arama İşlemleri:**

1. **Gözlemleri Ara** - Gözlemler genelinde tam metin arama
2. **Oturumları Ara** - Oturum özetleri genelinde tam metin arama
3. **İstemleri Ara** - Ham kullanıcı isteklerini ara
4. **Konsepte Göre** - Konsept etiketlerine göre bul (keşif, problem-çözüm, desen, vb.)
5. **Dosyaya Göre** - Belirli dosyalara referans veren gözlemleri bul
6. **Türe Göre** - Türe göre bul (karar, hata düzeltme, özellik, yeniden yapılandırma, keşif, değişiklik)
7. **Son Bağlam** - Bir proje için son oturum bağlamını al
8. **Zaman Çizelgesi** - Belirli bir zaman noktası etrafındaki bağlamın birleşik zaman çizelgesini al
9. **Sorguya Göre Zaman Çizelgesi** - Gözlemleri ara ve en iyi eşleşme etrafındaki zaman çizelgesi bağlamını al
10. **API Yardımı** - Arama API dokümantasyonunu al

**Örnek Doğal Dil Sorguları:**

```
"Geçen oturumda hangi hataları düzelttik?"
"Kimlik doğrulamayı nasıl uyguladık?"
"worker-service.ts dosyasında hangi değişiklikler yapıldı?"
"Bu projedeki son çalışmaları göster"
"Görüntüleyici arayüzünü eklediğimizde ne oluyordu?"
```

Detaylı örnekler için [Arama Araçları Kılavuzu](https://docs.claude-mem.ai/usage/search-tools) sayfasına bakın.

---

## Beta Özellikleri ve Endless Mode

Claude-Mem, deneysel özellikler içeren bir **beta kanalı** sunar. Web görüntüleyici arayüzünden doğrudan kararlı ve beta sürümleri arasında geçiş yapabilirsiniz.

### Beta'yı Nasıl Denersiniz

1. http://localhost:37777 adresini açın
2. Ayarlar'a (dişli simgesi) tıklayın
3. **Version Channel** bölümünde "Try Beta (Endless Mode)" seçeneğine tıklayın
4. Worker'ın yeniden başlamasını bekleyin

Sürüm değiştirirken hafıza verileriniz korunur.

### Endless Mode (Beta)

Temel beta özelliği **Endless Mode**'dur - oturum uzunluğunu önemli ölçüde artıran biyomimetik bir hafıza mimarisi:

**Problem**: Standart Claude Code oturumları ~50 araç kullanımından sonra bağlam sınırlarına ulaşır. Her araç 1-10k+ token ekler ve Claude her yanıtta önceki tüm çıktıları yeniden sentezler (O(N²) karmaşıklığı).

**Çözüm**: Endless Mode, araç çıktılarını ~500 token'lık gözlemlere sıkıştırır ve transkripti gerçek zamanlı olarak dönüştürür:

```
Çalışma Belleği (Bağlam):     Sıkıştırılmış gözlemler (her biri ~500 token)
Arşiv Belleği (Disk):         Geri çağırma için korunan tam araç çıktıları
```

**Beklenen Sonuçlar**:
- Bağlam penceresinde ~%95 token azalması
- Bağlam tükenmesinden önce ~20 kat daha fazla araç kullanımı
- Kuadratik O(N²) yerine doğrusal O(N) ölçekleme
- Mükemmel geri çağırma için korunan tam transkriptler

**Uyarılar**: Gecikme ekler (gözlem oluşturma için araç başına 60-90 saniye), hala deneyseldir.

Detaylar için [Beta Özellikleri Dokümantasyonu](https://docs.claude-mem.ai/beta-features) sayfasına bakın.

---

## Yenilikler

**v6.4.9 - Bağlam Yapılandırma Ayarları:**
- Bağlam enjeksiyonu üzerinde ayrıntılı kontrol için 11 yeni ayar
- Token ekonomisi gösterimini, türe/konsepte göre gözlem filtrelemeyi yapılandırın
- Gözlem sayısını ve hangi alanların gösterileceğini kontrol edin

**v6.4.0 - Çift Etiketli Gizlilik Sistemi:**
- Kullanıcı kontrollü gizlilik için `<private>` etiketleri - hassas içeriği depolamadan hariç tutmak için sarın
- Sistem düzeyinde `<claude-mem-context>` etiketleri özyinelemeli gözlem depolamayı önler
- Kenar işleme, özel içeriğin asla veritabanına ulaşmamasını sağlar

**v6.3.0 - Sürüm Kanalı:**
- Web görüntüleyici arayüzünden kararlı ve beta sürümleri arasında geçiş yapın
- Manuel git işlemleri olmadan Endless Mode gibi deneysel özellikleri deneyin

**Önceki Öne Çıkanlar:**
- **v6.0.0**: Büyük oturum yönetimi ve transkript işleme iyileştirmeleri
- **v5.5.0**: %100 etkinlik oranı ile mem-search becerisi geliştirmesi
- **v5.4.0**: Beceri tabanlı arama mimarisi (oturum başına ~2,250 token tasarrufu)
- **v5.1.0**: Gerçek zamanlı güncellemeler ile web tabanlı görüntüleyici arayüzü
- **v5.0.0**: Chroma vektör veritabanı ile hibrit arama

Tam sürüm geçmişi için [CHANGELOG.md](CHANGELOG.md) dosyasına bakın.

---

## Sistem Gereksinimleri

- **Node.js**: 18.0.0 veya üzeri
- **Claude Code**: Plugin desteği olan en son sürüm
- **PM2**: Süreç yöneticisi (dahil - global kurulum gerekmez)
- **SQLite 3**: Kalıcı depolama için (dahil)

---

## Temel Faydalar

### Aşamalı Açığa Çıkarma Bağlamı

- **Katmanlı hafıza erişimi** insan hafıza kalıplarını yansıtır
- **Katman 1 (İndeks)**: Oturum başlangıcında hangi gözlemlerin mevcut olduğunu token maliyetleriyle görün
- **Katman 2 (Detaylar)**: MCP arama aracılığıyla talep üzerine tam anlatımları getirin
- **Katman 3 (Mükemmel Geri Çağırma)**: Kaynak koduna ve orijinal transkriptlere erişin
- **Akıllı karar verme**: Token sayıları, Claude'un detayları getirme veya kodu okuma arasında seçim yapmasına yardımcı olur
- **Tür göstergeleri**: Görsel ipuçları (🔴 kritik, 🟤 karar, 🔵 bilgilendirici) gözlem önemini vurgular

### Otomatik Hafıza

- Claude başladığında bağlam otomatik olarak enjekte edilir
- Manuel komutlar veya yapılandırma gerekmez
- Arka planda şeffaf şekilde çalışır

### Tam Geçmiş Arama

- Tüm oturumlar ve gözlemler arasında arama
- Hızlı sorgular için FTS5 tam metin arama
- Alıntılar belirli gözlemlere geri bağlanır

### Yapılandırılmış Gözlemler

- AI destekli öğrenim çıkarımı
- Türe göre kategorize edilir (karar, hata düzeltme, özellik, vb.)
- Konseptler ve dosya referansları ile etiketlenir

### Çoklu İstem Oturumları

- Oturumlar birden fazla kullanıcı istemine yayılır
- Bağlam `/clear` komutları arasında korunur
- Tüm konuşma dizilerini takip edin

---

## Yapılandırma

Ayarlar `~/.claude-mem/settings.json` dosyasında yönetilir. Dosya ilk çalıştırmada varsayılan değerlerle otomatik olarak oluşturulur.

**Mevcut Ayarlar:**

| Ayar | Varsayılan | Açıklama |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | Gözlemler için AI modeli |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | Worker servis portu |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | Veri dizini konumu |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | Log ayrıntı düzeyi (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | chroma-mcp için Python sürümü |
| `CLAUDE_CODE_PATH` | _(otomatik-tespit)_ | Claude çalıştırılabilir dosyasının yolu |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | SessionStart'ta enjekte edilecek gözlem sayısı |

**Ayar Yönetimi:**

```bash
# CLI yardımcısı ile ayarları düzenle
./claude-mem-settings.sh

# Veya doğrudan düzenle
nano ~/.claude-mem/settings.json

# Mevcut ayarları görüntüle
curl http://localhost:37777/api/settings
```

**Ayar Dosyası Formatı:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

Detaylar için [Yapılandırma Kılavuzu](https://docs.claude-mem.ai/configuration) sayfasına bakın.

---

## Geliştirme

```bash
# Klonla ve derle
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# Testleri çalıştır
npm test

# Worker'ı başlat
npm run worker:start

# Logları görüntüle
npm run worker:logs
```

Detaylı talimatlar için [Geliştirme Kılavuzu](https://docs.claude-mem.ai/development) sayfasına bakın.

---

## Sorun Giderme

**Hızlı Tanı:**

Sorun yaşıyorsanız, sorunu Claude'a açıklayın; troubleshoot becerisi otomatik olarak devreye girerek tanı koyacak ve çözümler sunacaktır.

**Yaygın Sorunlar:**

- Worker başlamıyor → `npm run worker:restart`
- Bağlam görünmüyor → `npm run test:context`
- Veritabanı sorunları → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Arama çalışmıyor → FTS5 tablolarının mevcut olup olmadığını kontrol edin

Tam çözümler için [Sorun Giderme Kılavuzu](https://docs.claude-mem.ai/troubleshooting) sayfasına bakın.

---

## Katkıda Bulunma

Katkılar memnuniyetle karşılanır! Lütfen:

1. Depoyu fork edin
2. Bir özellik dalı oluşturun
3. Testlerle değişikliklerinizi yapın
4. Dokümantasyonu güncelleyin
5. Bir Pull Request gönderin

Katkı iş akışı için [Geliştirme Kılavuzu](https://docs.claude-mem.ai/development) sayfasına bakın.

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

---

## Destek

- **Dokümantasyon**: [docs/](docs/)
- **Sorunlar**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Depo**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Yazar**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Claude Agent SDK ile Geliştirildi** | **Claude Code ile Desteklenmektedir** | **TypeScript ile Yapıldı**