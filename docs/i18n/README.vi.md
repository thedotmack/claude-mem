🌐 Đây là bản dịch tự động. Chúng tôi hoan nghênh các đóng góp từ cộng đồng!

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

<h4 align="center">Hệ thống nén bộ nhớ liên tục được xây dựng cho <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#bắt-đầu-nhanh">Bắt Đầu Nhanh</a> •
  <a href="#cách-hoạt-động">Cách Hoạt Động</a> •
  <a href="#công-cụ-tìm-kiếm-mcp">Công Cụ Tìm Kiếm</a> •
  <a href="#tài-liệu">Tài Liệu</a> •
  <a href="#cấu-hình">Cấu Hình</a> •
  <a href="#khắc-phục-sự-cố">Khắc Phục Sự Cố</a> •
  <a href="#giấy-phép">Giấy Phép</a>
</p>

<p align="center">
  Claude-Mem duy trì ngữ cảnh liền mạch qua các phiên làm việc bằng cách tự động ghi lại các quan sát về việc sử dụng công cụ, tạo tóm tắt ngữ nghĩa và cung cấp chúng cho các phiên làm việc trong tương lai. Điều này giúp Claude duy trì tính liên tục của kiến thức về các dự án ngay cả sau khi phiên làm việc kết thúc hoặc kết nối lại.
</p>

---

## Bắt Đầu Nhanh

Bắt đầu một phiên Claude Code mới trong terminal và nhập các lệnh sau:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Khởi động lại Claude Code. Ngữ cảnh từ các phiên trước sẽ tự động xuất hiện trong các phiên mới.

**Tính Năng Chính:**

- 🧠 **Bộ Nhớ Liên Tục** - Ngữ cảnh được lưu giữ qua các phiên làm việc
- 📊 **Tiết Lộ Tuần Tự** - Truy xuất bộ nhớ theo lớp với khả năng hiển thị chi phí token
- 🔍 **Tìm Kiếm Theo Kỹ Năng** - Truy vấn lịch sử dự án với kỹ năng mem-search
- 🖥️ **Giao Diện Web Viewer** - Luồng bộ nhớ thời gian thực tại http://localhost:37777
- 💻 **Kỹ Năng Claude Desktop** - Tìm kiếm bộ nhớ từ các cuộc trò chuyện Claude Desktop
- 🔒 **Kiểm Soát Quyền Riêng Tư** - Sử dụng thẻ `<private>` để loại trừ nội dung nhạy cảm khỏi lưu trữ
- ⚙️ **Cấu Hình Ngữ Cảnh** - Kiểm soát chi tiết về ngữ cảnh được chèn vào
- 🤖 **Hoạt Động Tự Động** - Không cần can thiệp thủ công
- 🔗 **Trích Dẫn** - Tham chiếu các quan sát trong quá khứ với ID (truy cập qua http://localhost:37777/api/observation/{id} hoặc xem tất cả trong web viewer tại http://localhost:37777)
- 🧪 **Kênh Beta** - Dùng thử các tính năng thử nghiệm như Endless Mode thông qua chuyển đổi phiên bản

---

## Tài Liệu

📚 **[Xem Tài Liệu Đầy Đủ](https://docs.claude-mem.ai/)** - Duyệt trên trang web chính thức

### Bắt Đầu

- **[Hướng Dẫn Cài Đặt](https://docs.claude-mem.ai/installation)** - Bắt đầu nhanh & cài đặt nâng cao
- **[Hướng Dẫn Sử Dụng](https://docs.claude-mem.ai/usage/getting-started)** - Cách Claude-Mem hoạt động tự động
- **[Công Cụ Tìm Kiếm](https://docs.claude-mem.ai/usage/search-tools)** - Truy vấn lịch sử dự án bằng ngôn ngữ tự nhiên
- **[Tính Năng Beta](https://docs.claude-mem.ai/beta-features)** - Dùng thử các tính năng thử nghiệm như Endless Mode

### Thực Hành Tốt Nhất

- **[Kỹ Thuật Ngữ Cảnh](https://docs.claude-mem.ai/context-engineering)** - Các nguyên tắc tối ưu hóa ngữ cảnh cho AI agent
- **[Tiết Lộ Tuần Tự](https://docs.claude-mem.ai/progressive-disclosure)** - Triết lý đằng sau chiến lược chuẩn bị ngữ cảnh của Claude-Mem

### Kiến Trúc

- **[Tổng Quan](https://docs.claude-mem.ai/architecture/overview)** - Các thành phần hệ thống & luồng dữ liệu
- **[Phát Triển Kiến Trúc](https://docs.claude-mem.ai/architecture-evolution)** - Hành trình từ v3 đến v5
- **[Kiến Trúc Hooks](https://docs.claude-mem.ai/hooks-architecture)** - Cách Claude-Mem sử dụng lifecycle hooks
- **[Tham Chiếu Hooks](https://docs.claude-mem.ai/architecture/hooks)** - Giải thích 7 hook scripts
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API & quản lý Bun
- **[Cơ Sở Dữ Liệu](https://docs.claude-mem.ai/architecture/database)** - Schema SQLite & tìm kiếm FTS5
- **[Kiến Trúc Tìm Kiếm](https://docs.claude-mem.ai/architecture/search-architecture)** - Tìm kiếm kết hợp với cơ sở dữ liệu vector Chroma

### Cấu Hình & Phát Triển

- **[Cấu Hình](https://docs.claude-mem.ai/configuration)** - Biến môi trường & cài đặt
- **[Phát Triển](https://docs.claude-mem.ai/development)** - Xây dựng, kiểm thử, đóng góp
- **[Khắc Phục Sự Cố](https://docs.claude-mem.ai/troubleshooting)** - Các vấn đề thường gặp & giải pháp

---

## Cách Hoạt Động

**Các Thành Phần Cốt Lõi:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook scripts)
2. **Smart Install** - Công cụ kiểm tra phụ thuộc được cache (pre-hook script, không phải lifecycle hook)
3. **Worker Service** - HTTP API trên cổng 37777 với giao diện web viewer và 10 điểm cuối tìm kiếm, được quản lý bởi Bun
4. **SQLite Database** - Lưu trữ các phiên, quan sát, tóm tắt
5. **mem-search Skill** - Truy vấn ngôn ngữ tự nhiên với tiết lộ tuần tự
6. **Chroma Vector Database** - Tìm kiếm kết hợp ngữ nghĩa + từ khóa để truy xuất ngữ cảnh thông minh

Xem [Tổng Quan Kiến Trúc](https://docs.claude-mem.ai/architecture/overview) để biết chi tiết.

---

## mem-search Skill

Claude-Mem cung cấp tìm kiếm thông minh thông qua kỹ năng mem-search tự động kích hoạt khi bạn hỏi về công việc trước đây:

**Cách Hoạt Động:**
- Chỉ cần hỏi một cách tự nhiên: *"Chúng ta đã làm gì trong phiên trước?"* hoặc *"Chúng ta đã sửa lỗi này trước đây chưa?"*
- Claude tự động gọi kỹ năng mem-search để tìm ngữ cảnh liên quan

**Các Thao Tác Tìm Kiếm Có Sẵn:**

1. **Search Observations** - Tìm kiếm toàn văn trên các quan sát
2. **Search Sessions** - Tìm kiếm toàn văn trên các tóm tắt phiên
3. **Search Prompts** - Tìm kiếm các yêu cầu người dùng thô
4. **By Concept** - Tìm theo thẻ khái niệm (discovery, problem-solution, pattern, v.v.)
5. **By File** - Tìm các quan sát tham chiếu đến các tệp cụ thể
6. **By Type** - Tìm theo loại (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Lấy ngữ cảnh phiên gần đây cho một dự án
8. **Timeline** - Lấy dòng thời gian thống nhất của ngữ cảnh xung quanh một thời điểm cụ thể
9. **Timeline by Query** - Tìm kiếm các quan sát và lấy ngữ cảnh dòng thời gian xung quanh kết quả khớp tốt nhất
10. **API Help** - Lấy tài liệu API tìm kiếm

**Ví Dụ Truy Vấn Ngôn Ngữ Tự Nhiên:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

Xem [Hướng Dẫn Công Cụ Tìm Kiếm](https://docs.claude-mem.ai/usage/search-tools) để biết các ví dụ chi tiết.

---

## Tính Năng Beta

Claude-Mem cung cấp **kênh beta** với các tính năng thử nghiệm như **Endless Mode** (kiến trúc bộ nhớ sinh học mô phỏng cho các phiên mở rộng). Chuyển đổi giữa các phiên bản ổn định và beta từ giao diện web viewer tại http://localhost:37777 → Settings.

Xem **[Tài Liệu Tính Năng Beta](https://docs.claude-mem.ai/beta-features)** để biết chi tiết về Endless Mode và cách dùng thử.

---

## Yêu Cầu Hệ Thống

- **Node.js**: 18.0.0 hoặc cao hơn
- **Claude Code**: Phiên bản mới nhất với hỗ trợ plugin
- **Bun**: JavaScript runtime và trình quản lý tiến trình (tự động cài đặt nếu thiếu)
- **uv**: Trình quản lý gói Python cho tìm kiếm vector (tự động cài đặt nếu thiếu)
- **SQLite 3**: Cho lưu trữ liên tục (đi kèm)

---

## Cấu Hình

Cài đặt được quản lý trong `~/.claude-mem/settings.json` (tự động tạo với giá trị mặc định khi chạy lần đầu). Cấu hình mô hình AI, cổng worker, thư mục dữ liệu, mức độ log và cài đặt chèn ngữ cảnh.

Xem **[Hướng Dẫn Cấu Hình](https://docs.claude-mem.ai/configuration)** để biết tất cả các cài đặt và ví dụ có sẵn.

---

## Phát Triển

Xem **[Hướng Dẫn Phát Triển](https://docs.claude-mem.ai/development)** để biết hướng dẫn xây dựng, kiểm thử và quy trình đóng góp.

---

## Khắc Phục Sự Cố

Nếu gặp sự cố, hãy mô tả vấn đề cho Claude và kỹ năng troubleshoot sẽ tự động chẩn đoán và cung cấp các bản sửa lỗi.

Xem **[Hướng Dẫn Khắc Phục Sự Cố](https://docs.claude-mem.ai/troubleshooting)** để biết các vấn đề thường gặp và giải pháp.

---

## Báo Cáo Lỗi

Tạo báo cáo lỗi toàn diện với trình tạo tự động:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Đóng Góp

Chúng tôi hoan nghênh các đóng góp! Vui lòng:

1. Fork repository
2. Tạo nhánh tính năng
3. Thực hiện thay đổi của bạn kèm kiểm thử
4. Cập nhật tài liệu
5. Gửi Pull Request

Xem [Hướng Dẫn Phát Triển](https://docs.claude-mem.ai/development) để biết quy trình đóng góp.

---

## Giấy Phép

Dự án này được cấp phép theo **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Bảo lưu mọi quyền.

Xem tệp [LICENSE](LICENSE) để biết chi tiết đầy đủ.

**Điều Này Có Nghĩa Là:**

- Bạn có thể sử dụng, sửa đổi và phân phối phần mềm này tự do
- Nếu bạn sửa đổi và triển khai trên máy chủ mạng, bạn phải cung cấp mã nguồn của mình
- Các tác phẩm phái sinh cũng phải được cấp phép theo AGPL-3.0
- KHÔNG CÓ BẢO HÀNH cho phần mềm này

**Lưu Ý Về Ragtime**: Thư mục `ragtime/` được cấp phép riêng theo **PolyForm Noncommercial License 1.0.0**. Xem [ragtime/LICENSE](ragtime/LICENSE) để biết chi tiết.

---

## Hỗ Trợ

- **Tài Liệu**: [docs/](docs/)
- **Vấn Đề**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Tác Giả**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Được Xây Dựng với Claude Agent SDK** | **Được Hỗ Trợ bởi Claude Code** | **Được Tạo với TypeScript**