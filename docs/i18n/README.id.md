🌐 Ini adalah terjemahan otomatis. Koreksi dari komunitas sangat diterima!

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

<h4 align="center">Sistem kompresi memori persisten yang dibangun untuk <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#mulai-cepat">Mulai Cepat</a> •
  <a href="#cara-kerja">Cara Kerja</a> •
  <a href="#alat-pencarian-mcp">Alat Pencarian</a> •
  <a href="#dokumentasi">Dokumentasi</a> •
  <a href="#konfigurasi">Konfigurasi</a> •
  <a href="#pemecahan-masalah">Pemecahan Masalah</a> •
  <a href="#lisensi">Lisensi</a>
</p>

<p align="center">
  Claude-Mem menjaga konteks secara mulus lintas sesi dengan secara otomatis menangkap observasi penggunaan tool, menghasilkan ringkasan semantik, dan membuatnya tersedia untuk sesi mendatang. Ini memungkinkan Claude untuk mempertahankan kontinuitas pengetahuan tentang proyek bahkan setelah sesi berakhir atau terhubung kembali.
</p>

---

## Mulai Cepat

Mulai sesi Claude Code baru di terminal dan masukkan perintah berikut:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Restart Claude Code. Konteks dari sesi sebelumnya akan otomatis muncul di sesi baru.

**Fitur Utama:**

- 🧠 **Memori Persisten** - Konteks bertahan lintas sesi
- 📊 **Progressive Disclosure** - Pengambilan memori berlapis dengan visibilitas biaya token
- 🔍 **Pencarian Berbasis Skill** - Query riwayat proyek Anda dengan skill mem-search (hemat ~2.250 token)
- 🖥️ **UI Viewer Web** - Stream memori real-time di http://localhost:37777
- 🔒 **Kontrol Privasi** - Gunakan tag `<private>` untuk mengecualikan konten sensitif dari penyimpanan
- ⚙️ **Konfigurasi Konteks** - Kontrol granular atas konteks yang diinjeksi
- 🤖 **Operasi Otomatis** - Tidak memerlukan intervensi manual
- 🔗 **Sitasi** - Referensi keputusan masa lalu dengan URI `claude-mem://`
- 🧪 **Kanal Beta** - Coba fitur eksperimental seperti Endless Mode melalui penggantian versi

---

## Dokumentasi

📚 **[Lihat Dokumentasi Lengkap](docs/)** - Telusuri dokumen markdown di GitHub

💻 **Pratinjau Lokal**: Jalankan dokumen Mintlify secara lokal:

```bash
cd docs
npx mintlify dev
```

### Memulai

- **[Panduan Instalasi](https://docs.claude-mem.ai/installation)** - Mulai cepat & instalasi lanjutan
- **[Panduan Penggunaan](https://docs.claude-mem.ai/usage/getting-started)** - Bagaimana Claude-Mem bekerja secara otomatis
- **[Alat Pencarian](https://docs.claude-mem.ai/usage/search-tools)** - Query riwayat proyek Anda dengan bahasa alami
- **[Fitur Beta](https://docs.claude-mem.ai/beta-features)** - Coba fitur eksperimental seperti Endless Mode

### Praktik Terbaik

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - Prinsip optimasi konteks AI agent
- **[Progressive Disclosure](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofi di balik strategi context priming Claude-Mem

### Arsitektur

- **[Ikhtisar](https://docs.claude-mem.ai/architecture/overview)** - Komponen sistem & alur data
- **[Evolusi Arsitektur](https://docs.claude-mem.ai/architecture-evolution)** - Perjalanan dari v3 ke v5
- **[Arsitektur Hooks](https://docs.claude-mem.ai/hooks-architecture)** - Bagaimana Claude-Mem menggunakan lifecycle hooks
- **[Referensi Hooks](https://docs.claude-mem.ai/architecture/hooks)** - 7 skrip hook dijelaskan
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API & manajemen PM2
- **[Database](https://docs.claude-mem.ai/architecture/database)** - Skema SQLite & pencarian FTS5
- **[Arsitektur Pencarian](https://docs.claude-mem.ai/architecture/search-architecture)** - Pencarian hybrid dengan database vektor Chroma

### Konfigurasi & Pengembangan

- **[Konfigurasi](https://docs.claude-mem.ai/configuration)** - Variabel environment & pengaturan
- **[Pengembangan](https://docs.claude-mem.ai/development)** - Membangun, menguji, berkontribusi
- **[Pemecahan Masalah](https://docs.claude-mem.ai/troubleshooting)** - Masalah umum & solusi

---

## Cara Kerja

```
┌─────────────────────────────────────────────────────────────┐
│ Session Start → Injeksi observasi terkini sebagai konteks  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ User Prompts → Buat sesi, simpan prompt pengguna           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Tool Executions → Tangkap observasi (Read, Write, dll.)    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Worker Processes → Ekstrak pembelajaran via Claude Agent SDK│
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Session Ends → Hasilkan ringkasan, siap untuk sesi berikut │
└─────────────────────────────────────────────────────────────┘
```

**Komponen Inti:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 skrip hook)
2. **Smart Install** - Pemeriksa dependensi yang di-cache (skrip pre-hook, bukan lifecycle hook)
3. **Worker Service** - HTTP API di port 37777 dengan UI viewer web dan 10 endpoint pencarian, dikelola oleh PM2
4. **SQLite Database** - Menyimpan sesi, observasi, ringkasan dengan pencarian teks penuh FTS5
5. **mem-search Skill** - Query bahasa alami dengan progressive disclosure (hemat ~2.250 token vs MCP)
6. **Chroma Vector Database** - Pencarian hybrid semantik + kata kunci untuk pengambilan konteks yang cerdas

Lihat [Ikhtisar Arsitektur](https://docs.claude-mem.ai/architecture/overview) untuk detail.

---

## mem-search Skill

Claude-Mem menyediakan pencarian cerdas melalui skill mem-search yang otomatis terinvokasi ketika Anda bertanya tentang pekerjaan masa lalu:

**Cara Kerja:**
- Tanyakan secara alami: *"Apa yang kita lakukan sesi terakhir?"* atau *"Apakah kita sudah memperbaiki bug ini sebelumnya?"*
- Claude secara otomatis memanggil skill mem-search untuk menemukan konteks yang relevan
- Hemat ~2.250 token per awal sesi vs pendekatan MCP

**Operasi Pencarian yang Tersedia:**

1. **Search Observations** - Pencarian teks penuh di seluruh observasi
2. **Search Sessions** - Pencarian teks penuh di seluruh ringkasan sesi
3. **Search Prompts** - Cari permintaan pengguna mentah
4. **By Concept** - Temukan berdasarkan tag konsep (discovery, problem-solution, pattern, dll.)
5. **By File** - Temukan observasi yang mereferensikan file tertentu
6. **By Type** - Temukan berdasarkan tipe (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Dapatkan konteks sesi terkini untuk sebuah proyek
8. **Timeline** - Dapatkan timeline terpadu dari konteks di sekitar titik waktu tertentu
9. **Timeline by Query** - Cari observasi dan dapatkan konteks timeline di sekitar hasil terbaik
10. **API Help** - Dapatkan dokumentasi API pencarian

**Contoh Query Bahasa Alami:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

Lihat [Panduan Alat Pencarian](https://docs.claude-mem.ai/usage/search-tools) untuk contoh detail.

---

## Fitur Beta & Endless Mode

Claude-Mem menawarkan **kanal beta** dengan fitur eksperimental. Beralih antara versi stabil dan beta langsung dari UI viewer web.

### Cara Mencoba Beta

1. Buka http://localhost:37777
2. Klik Settings (ikon gear)
3. Di **Version Channel**, klik "Try Beta (Endless Mode)"
4. Tunggu worker restart

Data memori Anda tetap tersimpan saat beralih versi.

### Endless Mode (Beta)

Fitur beta unggulan adalah **Endless Mode** - arsitektur memori biomimetik yang secara dramatis memperpanjang durasi sesi:

**Masalah**: Sesi Claude Code standar mencapai batas konteks setelah ~50 penggunaan tool. Setiap tool menambahkan 1-10k+ token, dan Claude mensintesis ulang semua output sebelumnya pada setiap respons (kompleksitas O(N²)).

**Solusi**: Endless Mode mengompresi output tool menjadi observasi ~500-token dan mentransformasi transkrip secara real-time:

```
Working Memory (Context):     Observasi terkompresi (~500 token setiap)
Archive Memory (Disk):        Output tool lengkap tersimpan untuk recall
```

**Hasil yang Diharapkan**:
- Pengurangan token ~95% di context window
- Penggunaan tool ~20x lebih banyak sebelum exhaustion konteks
- Skala linier O(N) bukan kuadratik O(N²)
- Transkrip lengkap tersimpan untuk recall sempurna

**Catatan**: Menambah latensi (60-90 detik per tool untuk generasi observasi), masih eksperimental.

Lihat [Dokumentasi Fitur Beta](https://docs.claude-mem.ai/beta-features) untuk detail.

---

## Yang Baru

**v6.4.9 - Pengaturan Konfigurasi Konteks:**
- 11 pengaturan baru untuk kontrol granular atas injeksi konteks
- Konfigurasikan tampilan ekonomi token, penyaringan observasi berdasarkan tipe/konsep
- Kontrol jumlah observasi dan field mana yang ditampilkan

**v6.4.0 - Sistem Privasi Dual-Tag:**
- Tag `<private>` untuk privasi yang dikontrol pengguna - bungkus konten sensitif untuk dikecualikan dari penyimpanan
- Tag `<claude-mem-context>` tingkat sistem mencegah penyimpanan observasi rekursif
- Pemrosesan edge memastikan konten privat tidak pernah mencapai database

**v6.3.0 - Version Channel:**
- Beralih antara versi stabil dan beta dari UI viewer web
- Coba fitur eksperimental seperti Endless Mode tanpa operasi git manual

**Sorotan Sebelumnya:**
- **v6.0.0**: Peningkatan besar manajemen sesi & pemrosesan transkrip
- **v5.5.0**: Peningkatan skill mem-search dengan tingkat efektivitas 100%
- **v5.4.0**: Arsitektur pencarian berbasis skill (hemat ~2.250 token per sesi)
- **v5.1.0**: UI viewer berbasis web dengan update real-time
- **v5.0.0**: Pencarian hybrid dengan database vektor Chroma

Lihat [CHANGELOG.md](CHANGELOG.md) untuk riwayat versi lengkap.

---

## Persyaratan Sistem

- **Node.js**: 18.0.0 atau lebih tinggi
- **Claude Code**: Versi terbaru dengan dukungan plugin
- **PM2**: Process manager (sudah bundled - tidak perlu instalasi global)
- **SQLite 3**: Untuk penyimpanan persisten (sudah bundled)

---

## Manfaat Utama

### Konteks Progressive Disclosure

- **Pengambilan memori berlapis** mencerminkan pola memori manusia
- **Layer 1 (Index)**: Lihat observasi apa yang ada dengan biaya token di awal sesi
- **Layer 2 (Details)**: Ambil narasi lengkap on-demand via pencarian MCP
- **Layer 3 (Perfect Recall)**: Akses kode sumber dan transkrip asli
- **Pengambilan keputusan cerdas**: Jumlah token membantu Claude memilih antara mengambil detail atau membaca kode
- **Indikator tipe**: Isyarat visual (🔴 critical, 🟤 decision, 🔵 informational) menyoroti pentingnya observasi

### Memori Otomatis

- Konteks otomatis diinjeksi ketika Claude mulai
- Tidak perlu perintah manual atau konfigurasi
- Bekerja secara transparan di latar belakang

### Pencarian Riwayat Lengkap

- Cari di semua sesi dan observasi
- Pencarian teks penuh FTS5 untuk query cepat
- Sitasi terhubung kembali ke observasi spesifik

### Observasi Terstruktur

- Ekstraksi pembelajaran bertenaga AI
- Dikategorikan berdasarkan tipe (decision, bugfix, feature, dll.)
- Diberi tag dengan konsep dan referensi file

### Sesi Multi-Prompt

- Sesi mencakup beberapa prompt pengguna
- Konteks tersimpan lintas perintah `/clear`
- Lacak seluruh thread percakapan

---

## Konfigurasi

Pengaturan dikelola di `~/.claude-mem/settings.json`. File dibuat otomatis dengan default di jalankan pertama kali.

**Pengaturan yang Tersedia:**

| Pengaturan | Default | Deskripsi |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | Model AI untuk observasi |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | Port worker service |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | Lokasi direktori data |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | Verbositas log (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | Versi Python untuk chroma-mcp |
| `CLAUDE_CODE_PATH` | _(deteksi otomatis)_ | Path ke executable Claude |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Jumlah observasi untuk diinjeksi di SessionStart |

**Manajemen Pengaturan:**

```bash
# Edit pengaturan via helper CLI
./claude-mem-settings.sh

# Atau edit langsung
nano ~/.claude-mem/settings.json

# Lihat pengaturan saat ini
curl http://localhost:37777/api/settings
```

**Format File Pengaturan:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

Lihat [Panduan Konfigurasi](https://docs.claude-mem.ai/configuration) untuk detail.

---

## Pengembangan

```bash
# Clone dan build
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# Jalankan tes
npm test

# Start worker
npm run worker:start

# Lihat log
npm run worker:logs
```

Lihat [Panduan Pengembangan](https://docs.claude-mem.ai/development) untuk instruksi detail.

---

## Pemecahan Masalah

**Diagnostik Cepat:**

Jika Anda mengalami masalah, jelaskan masalahnya kepada Claude dan skill troubleshoot akan otomatis aktif untuk mendiagnosis dan memberikan perbaikan.

**Masalah Umum:**

- Worker tidak mulai → `npm run worker:restart`
- Tidak ada konteks yang muncul → `npm run test:context`
- Masalah database → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Pencarian tidak bekerja → Periksa tabel FTS5 ada

Lihat [Panduan Pemecahan Masalah](https://docs.claude-mem.ai/troubleshooting) untuk solusi lengkap.

---

## Berkontribusi

Kontribusi sangat diterima! Silakan:

1. Fork repository
2. Buat branch fitur
3. Buat perubahan Anda dengan tes
4. Update dokumentasi
5. Submit Pull Request

Lihat [Panduan Pengembangan](https://docs.claude-mem.ai/development) untuk alur kerja kontribusi.

---

## Lisensi

Proyek ini dilisensikan di bawah **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Semua hak dilindungi.

Lihat file [LICENSE](LICENSE) untuk detail lengkap.

**Apa Artinya Ini:**

- Anda dapat menggunakan, memodifikasi, dan mendistribusikan software ini secara bebas
- Jika Anda memodifikasi dan deploy di server jaringan, Anda harus membuat kode sumber Anda tersedia
- Karya turunan juga harus dilisensikan di bawah AGPL-3.0
- TIDAK ADA JAMINAN untuk software ini

---

## Dukungan

- **Dokumentasi**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Author**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Dibangun dengan Claude Agent SDK** | **Didukung oleh Claude Code** | **Dibuat dengan TypeScript**