🌐 Ini adalah terjemahan otomatis. Koreksi dari komunitas sangat dipersilakan!

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

<h4 align="center">Sistem kompresi memori persisten yang dibangun untuk <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#mulai-cepat">Mulai Cepat</a> •
  <a href="#cara-kerja">Cara Kerja</a> •
  <a href="#alat-pencarian-mcp">Alat Pencarian</a> •
  <a href="#dokumentasi">Dokumentasi</a> •
  <a href="#konfigurasi">Konfigurasi</a> •
  <a href="#pemecahan-masalah">Pemecahan Masalah</a> •
  <a href="#lisensi">Lisensi</a>
</p>

<p align="center">
  Claude-Mem secara mulus mempertahankan konteks di seluruh sesi dengan secara otomatis menangkap observasi penggunaan alat, menghasilkan ringkasan semantik, dan membuatnya tersedia untuk sesi mendatang. Ini memungkinkan Claude untuk mempertahankan kontinuitas pengetahuan tentang proyek bahkan setelah sesi berakhir atau tersambung kembali.
</p>

---

## Mulai Cepat

Mulai sesi Claude Code baru di terminal dan masukkan perintah berikut:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Restart Claude Code. Konteks dari sesi sebelumnya akan secara otomatis muncul di sesi baru.

**Fitur Utama:**

- 🧠 **Memori Persisten** - Konteks bertahan di seluruh sesi
- 📊 **Progressive Disclosure** - Pengambilan memori berlapis dengan visibilitas biaya token
- 🔍 **Pencarian Berbasis Skill** - Query riwayat proyek Anda dengan mem-search skill
- 🖥️ **Web Viewer UI** - Stream memori real-time di http://localhost:37777
- 💻 **Claude Desktop Skill** - Cari memori dari percakapan Claude Desktop
- 🔒 **Kontrol Privasi** - Gunakan tag `<private>` untuk mengecualikan konten sensitif dari penyimpanan
- ⚙️ **Konfigurasi Konteks** - Kontrol yang detail atas konteks apa yang diinjeksikan
- 🤖 **Operasi Otomatis** - Tidak memerlukan intervensi manual
- 🔗 **Kutipan** - Referensi observasi masa lalu dengan ID (akses melalui http://localhost:37777/api/observation/{id} atau lihat semua di web viewer di http://localhost:37777)
- 🧪 **Beta Channel** - Coba fitur eksperimental seperti Endless Mode melalui peralihan versi

---

## Dokumentasi

📚 **[Lihat Dokumentasi Lengkap](https://docs.claude-mem.ai/)** - Jelajahi di situs web resmi

### Memulai

- **[Panduan Instalasi](https://docs.claude-mem.ai/installation)** - Mulai cepat & instalasi lanjutan
- **[Panduan Penggunaan](https://docs.claude-mem.ai/usage/getting-started)** - Bagaimana Claude-Mem bekerja secara otomatis
- **[Alat Pencarian](https://docs.claude-mem.ai/usage/search-tools)** - Query riwayat proyek Anda dengan bahasa alami
- **[Fitur Beta](https://docs.claude-mem.ai/beta-features)** - Coba fitur eksperimental seperti Endless Mode

### Praktik Terbaik

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - Prinsip optimisasi konteks agen AI
- **[Progressive Disclosure](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofi di balik strategi priming konteks Claude-Mem

### Arsitektur

- **[Ringkasan](https://docs.claude-mem.ai/architecture/overview)** - Komponen sistem & aliran data
- **[Evolusi Arsitektur](https://docs.claude-mem.ai/architecture-evolution)** - Perjalanan dari v3 ke v5
- **[Arsitektur Hooks](https://docs.claude-mem.ai/hooks-architecture)** - Bagaimana Claude-Mem menggunakan lifecycle hooks
- **[Referensi Hooks](https://docs.claude-mem.ai/architecture/hooks)** - 7 skrip hook dijelaskan
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API & manajemen Bun
- **[Database](https://docs.claude-mem.ai/architecture/database)** - Skema SQLite & pencarian FTS5
- **[Arsitektur Pencarian](https://docs.claude-mem.ai/architecture/search-architecture)** - Pencarian hybrid dengan database vektor Chroma

### Konfigurasi & Pengembangan

- **[Konfigurasi](https://docs.claude-mem.ai/configuration)** - Variabel environment & pengaturan
- **[Pengembangan](https://docs.claude-mem.ai/development)** - Membangun, testing, kontribusi
- **[Pemecahan Masalah](https://docs.claude-mem.ai/troubleshooting)** - Masalah umum & solusi

---

## Cara Kerja

**Komponen Inti:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 skrip hook)
2. **Smart Install** - Pemeriksa dependensi yang di-cache (skrip pre-hook, bukan lifecycle hook)
3. **Worker Service** - HTTP API di port 37777 dengan web viewer UI dan 10 endpoint pencarian, dikelola oleh Bun
4. **SQLite Database** - Menyimpan sesi, observasi, ringkasan
5. **mem-search Skill** - Query bahasa alami dengan progressive disclosure
6. **Chroma Vector Database** - Pencarian hybrid semantik + keyword untuk pengambilan konteks yang cerdas

Lihat [Ringkasan Arsitektur](https://docs.claude-mem.ai/architecture/overview) untuk detail.

---

## mem-search Skill

Claude-Mem menyediakan pencarian cerdas melalui mem-search skill yang secara otomatis dipanggil saat Anda bertanya tentang pekerjaan masa lalu:

**Cara Kerja:**
- Tanya saja secara alami: *"Apa yang kita lakukan sesi terakhir?"* atau *"Apakah kita sudah memperbaiki bug ini sebelumnya?"*
- Claude secara otomatis memanggil mem-search skill untuk menemukan konteks yang relevan

**Operasi Pencarian yang Tersedia:**

1. **Search Observations** - Pencarian teks lengkap di seluruh observasi
2. **Search Sessions** - Pencarian teks lengkap di seluruh ringkasan sesi
3. **Search Prompts** - Cari permintaan pengguna mentah
4. **By Concept** - Temukan berdasarkan tag konsep (discovery, problem-solution, pattern, dll.)
5. **By File** - Temukan observasi yang mereferensikan file tertentu
6. **By Type** - Temukan berdasarkan tipe (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Dapatkan konteks sesi terbaru untuk sebuah proyek
8. **Timeline** - Dapatkan timeline terpadu dari konteks di sekitar titik waktu tertentu
9. **Timeline by Query** - Cari observasi dan dapatkan konteks timeline di sekitar kecocokan terbaik
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

## Fitur Beta

Claude-Mem menawarkan **beta channel** dengan fitur eksperimental seperti **Endless Mode** (arsitektur memori biomimetik untuk sesi yang diperpanjang). Beralih antara versi stabil dan beta dari web viewer UI di http://localhost:37777 → Settings.

Lihat **[Dokumentasi Fitur Beta](https://docs.claude-mem.ai/beta-features)** untuk detail tentang Endless Mode dan cara mencobanya.

---

## Persyaratan Sistem

- **Node.js**: 18.0.0 atau lebih tinggi
- **Claude Code**: Versi terbaru dengan dukungan plugin
- **Bun**: JavaScript runtime dan process manager (otomatis diinstal jika tidak ada)
- **uv**: Python package manager untuk pencarian vektor (otomatis diinstal jika tidak ada)
- **SQLite 3**: Untuk penyimpanan persisten (terbundel)

---

## Konfigurasi

Pengaturan dikelola di `~/.claude-mem/settings.json` (otomatis dibuat dengan default saat pertama kali dijalankan). Konfigurasi model AI, port worker, direktori data, level log, dan pengaturan injeksi konteks.

Lihat **[Panduan Konfigurasi](https://docs.claude-mem.ai/configuration)** untuk semua pengaturan dan contoh yang tersedia.

---

## Pengembangan

Lihat **[Panduan Pengembangan](https://docs.claude-mem.ai/development)** untuk instruksi build, testing, dan alur kerja kontribusi.

---

## Pemecahan Masalah

Jika mengalami masalah, jelaskan masalah ke Claude dan troubleshoot skill akan secara otomatis mendiagnosis dan memberikan perbaikan.

Lihat **[Panduan Pemecahan Masalah](https://docs.claude-mem.ai/troubleshooting)** untuk masalah umum dan solusi.

---

## Laporan Bug

Buat laporan bug yang komprehensif dengan generator otomatis:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Kontribusi

Kontribusi sangat dipersilakan! Silakan:

1. Fork repositori
2. Buat branch fitur
3. Buat perubahan Anda dengan tes
4. Perbarui dokumentasi
5. Kirim Pull Request

Lihat [Panduan Pengembangan](https://docs.claude-mem.ai/development) untuk alur kerja kontribusi.

---

## License

This project is licensed under the **Apache License 2.0** (Apache-2.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

Apache-2.0 allows broad use, modification, distribution, and commercial use, subject to its terms.

**Ragtime note**: The ragtime/ directory is licensed under the **Apache License 2.0**. See [ragtime/LICENSE](ragtime/LICENSE) for details.

---


## Dukungan

- **Dokumentasi**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repositori**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Penulis**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Built with Claude Agent SDK** | **Works with Claude Code** | **Made with TypeScript**

---